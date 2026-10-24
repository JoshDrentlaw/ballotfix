/**
 * WebAuthn ceremony verification.
 *
 * Registration and authentication are the same shape: the browser signs a
 * challenge we issued, and we check every claim in the response against
 * something we already knew. Every check below exists because skipping it opens
 * a specific hole, and each is annotated with which one.
 *
 * Attestation is deliberately **not** evaluated. Attestation answers "is this
 * authenticator model one I trust?", a question an enterprise asks about
 * hardware it did not buy. There is one user here enrolling their own devices,
 * from inside an already-authenticated session; the answer would be "yes"
 * every time, and verifying it would mean shipping certificate-chain and
 * revocation handling that has its own failure modes. The registration options
 * ask for `attestation: "none"` accordingly.
 *
 * User verification **is** required, on both ceremonies. A passkey here is a
 * complete credential — presenting it signs you in — so a device that only
 * proves presence ("someone touched this key") and not identity ("and it was
 * the owner") is not enough on its own.
 */

import { fromBase64Url } from "../encoding.ts";
import { asBytes, asText, CborError, decodeCborItem } from "./cbor.ts";
import { CoseError, importCoseKey, verifyCoseSignature } from "./cose.ts";

export class WebAuthnError extends Error {
  override readonly name = "WebAuthnError";
}

/** Authenticator data flags (WebAuthn §6.1). */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
const FLAG_EXTENSION_DATA = 0x80;

const AUTH_DATA_MINIMUM = 37; // rpIdHash(32) + flags(1) + signCount(4)

export interface ParsedAuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly signCount: number;
  readonly credentialId?: Uint8Array;
  readonly credentialPublicKey?: Uint8Array;
  readonly aaguid?: Uint8Array;
}

export function parseAuthenticatorData(data: Uint8Array): ParsedAuthenticatorData {
  if (data.length < AUTH_DATA_MINIMUM) {
    throw new WebAuthnError("Authenticator data is too short to be valid");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = data[32]!;
  const base = {
    rpIdHash: data.slice(0, 32),
    userPresent: (flags & FLAG_USER_PRESENT) !== 0,
    userVerified: (flags & FLAG_USER_VERIFIED) !== 0,
    backupEligible: (flags & FLAG_BACKUP_ELIGIBLE) !== 0,
    backedUp: (flags & FLAG_BACKED_UP) !== 0,
    signCount: view.getUint32(33),
  };

  if ((flags & FLAG_ATTESTED_CREDENTIAL_DATA) === 0) {
    if ((flags & FLAG_EXTENSION_DATA) === 0 && data.length !== AUTH_DATA_MINIMUM) {
      throw new WebAuthnError("Authenticator data has trailing bytes it did not declare");
    }
    return base;
  }

  // Attested credential data: aaguid(16) ‖ credentialIdLength(2) ‖ id ‖ COSE key.
  if (data.length < AUTH_DATA_MINIMUM + 18) {
    throw new WebAuthnError("Attested credential data is truncated");
  }
  const idLength = view.getUint16(53);
  const idStart = 55;
  if (idLength === 0 || idLength > 1023) {
    // The spec caps credential ids at 1023 bytes; anything longer is not one.
    throw new WebAuthnError("Credential id length is out of range");
  }
  if (data.length < idStart + idLength) throw new WebAuthnError("Credential id is truncated");

  const keyStart = idStart + idLength;
  let keyEnd: number;
  try {
    // The COSE key is self-delimiting, and finding its end is the only way to
    // know where optional extension data begins.
    keyEnd = decodeCborItem(data, keyStart).next;
  } catch (error) {
    if (error instanceof CborError) {
      throw new WebAuthnError(`Credential public key is malformed: ${error.message}`);
    }
    throw error;
  }

  return {
    ...base,
    aaguid: data.slice(37, 53),
    credentialId: data.slice(idStart, keyStart),
    credentialPublicKey: data.slice(keyStart, keyEnd),
  };
}

interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin?: boolean;
}

/**
 * The client data is JSON produced by the browser, but it reaches us through
 * the caller, so nothing in it is trusted until compared with what we issued.
 */
function parseClientData(json: Uint8Array, expectedType: string, expected: ExpectedOrigin): string {
  let parsed: ClientData;
  try {
    parsed = JSON.parse(new TextDecoder().decode(json)) as ClientData;
  } catch {
    throw new WebAuthnError("Client data is not valid JSON");
  }
  // Without the type check, a signature collected during registration could be
  // replayed as an authentication, and vice versa.
  if (parsed.type !== expectedType) {
    throw new WebAuthnError(`Client data type is "${parsed.type}", expected "${expectedType}"`);
  }
  // Without the origin check, a page on another site could drive the ceremony.
  if (parsed.origin !== expected.origin) {
    throw new WebAuthnError(`Ceremony was performed at "${parsed.origin}", not this origin`);
  }
  if (parsed.crossOrigin === true) {
    throw new WebAuthnError("Ceremony was performed inside a frame on another origin");
  }
  if (typeof parsed.challenge !== "string" || parsed.challenge === "") {
    throw new WebAuthnError("Client data carries no challenge");
  }
  return parsed.challenge;
}

export interface ExpectedOrigin {
  /** The registrable domain the credential is scoped to, e.g. `jobs.example.com`. */
  readonly rpId: string;
  /** The full origin the ceremony must have happened at, scheme and port included. */
  readonly origin: string;
}

async function assertRpIdMatches(rpIdHash: Uint8Array, rpId: string): Promise<void> {
  const expected = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
  );
  // Without this, a credential registered to another site's rpId would verify.
  if (rpIdHash.length !== expected.length) throw new WebAuthnError("rpIdHash is the wrong length");
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= rpIdHash[i]! ^ expected[i]!;
  if (mismatch !== 0) throw new WebAuthnError("This credential belongs to a different site");
}

function assertUserChecks(data: ParsedAuthenticatorData): void {
  if (!data.userPresent) throw new WebAuthnError("The authenticator reported no user present");
  if (!data.userVerified) {
    throw new WebAuthnError(
      "This device did not verify who you are. A passkey signs you in on its own, so it must " +
        "check a PIN, fingerprint or face — not only that someone touched it.",
    );
  }
}

/* ------------------------------------------------ registration ------------ */

export interface RegistrationResponse {
  readonly clientDataJSON: string;
  readonly attestationObject: string;
  /** What the browser says about how the credential can be used. Advisory. */
  readonly transports?: readonly string[];
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  /** The COSE key verbatim, base64url. Stored as given, never re-encoded. */
  readonly publicKey: string;
  readonly signCount: number;
  readonly aaguid: string | null;
  readonly backedUp: boolean;
  readonly attestationFormat: string;
  readonly challenge: string;
}

export async function verifyRegistration(
  response: RegistrationResponse,
  expected: ExpectedOrigin,
): Promise<VerifiedRegistration> {
  const clientDataJSON = decodeField(response.clientDataJSON, "clientDataJSON");
  const challenge = parseClientData(clientDataJSON, "webauthn.create", expected);

  const attestation = decodeField(response.attestationObject, "attestationObject");
  let fmt: string;
  let authData: Uint8Array;
  try {
    const decoded = decodeCborItem(attestation);
    if (decoded.next !== attestation.length) {
      throw new CborError("Trailing bytes after the attestation object");
    }
    if (!(decoded.value instanceof Map)) throw new CborError("Attestation object is not a map");
    fmt = asText(decoded.value.get("fmt"), "fmt");
    authData = asBytes(decoded.value.get("authData"), "authData");
  } catch (error) {
    if (error instanceof CborError) {
      throw new WebAuthnError(`Malformed attestation object: ${error.message}`);
    }
    throw error;
  }

  const parsed = parseAuthenticatorData(authData);
  await assertRpIdMatches(parsed.rpIdHash, expected.rpId);
  assertUserChecks(parsed);

  if (parsed.credentialId === undefined || parsed.credentialPublicKey === undefined) {
    throw new WebAuthnError("Registration produced no credential");
  }

  // Import now, at registration, so an algorithm we cannot verify is refused
  // while the user is watching rather than at the login that needs it.
  try {
    await importCoseKey(parsed.credentialPublicKey);
  } catch (error) {
    if (error instanceof CoseError) throw new WebAuthnError(error.message);
    throw error;
  }

  return {
    credentialId: toBase64Url(parsed.credentialId),
    publicKey: toBase64Url(parsed.credentialPublicKey),
    signCount: parsed.signCount,
    aaguid: parsed.aaguid === undefined ? null : toBase64Url(parsed.aaguid),
    backedUp: parsed.backedUp,
    attestationFormat: fmt,
    challenge,
  };
}

/* ------------------------------------------------ authentication ---------- */

export interface AuthenticationResponse {
  readonly credentialId: string;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
  readonly userHandle?: string | null;
}

export interface StoredCredentialKey {
  readonly credentialId: string;
  /** base64url COSE key, exactly as registered. */
  readonly publicKey: string;
  readonly signCount: number;
}

export interface VerifiedAuthentication {
  readonly credentialId: string;
  readonly signCount: number;
  readonly backedUp: boolean;
  readonly challenge: string;
}

export async function verifyAuthentication(
  response: AuthenticationResponse,
  credential: StoredCredentialKey,
  expected: ExpectedOrigin,
): Promise<VerifiedAuthentication> {
  if (response.credentialId !== credential.credentialId) {
    throw new WebAuthnError("This response is for a different credential");
  }

  const clientDataJSON = decodeField(response.clientDataJSON, "clientDataJSON");
  const challenge = parseClientData(clientDataJSON, "webauthn.get", expected);

  const authData = decodeField(response.authenticatorData, "authenticatorData");
  const parsed = parseAuthenticatorData(authData);
  await assertRpIdMatches(parsed.rpIdHash, expected.rpId);
  assertUserChecks(parsed);

  const key = await importCoseKey(decodeField(credential.publicKey, "stored public key"));
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientDataJSON as BufferSource),
  );
  const signed = new Uint8Array(authData.length + clientDataHash.length);
  signed.set(authData, 0);
  signed.set(clientDataHash, authData.length);

  const signature = decodeField(response.signature, "signature");
  if (!await verifyCoseSignature(key, signature, signed)) {
    throw new WebAuthnError("The signature does not verify");
  }

  // The counter detects a cloned authenticator: a copy cannot know how many
  // times the original has been used. Authenticators that never count report
  // zero forever, and the check does not apply to them — which is the spec's
  // own guidance, not a shortcut.
  if (parsed.signCount > 0 || credential.signCount > 0) {
    if (parsed.signCount <= credential.signCount) {
      throw new WebAuthnError(
        "The authenticator's use counter went backwards, which can mean the credential was copied.",
      );
    }
  }

  return {
    credentialId: credential.credentialId,
    signCount: parsed.signCount,
    backedUp: parsed.backedUp,
    challenge,
  };
}

/* ------------------------------------------------ helpers ----------------- */

function decodeField(value: string, what: string): Uint8Array {
  if (typeof value !== "string" || value === "") {
    throw new WebAuthnError(`Missing ${what}`);
  }
  try {
    return fromBase64Url(value);
  } catch {
    throw new WebAuthnError(`${what} is not base64url`);
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
