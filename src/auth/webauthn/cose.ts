/**
 * COSE keys and signature shapes.
 *
 * An authenticator hands back its public key as a COSE_Key and its signature in
 * whatever encoding the algorithm conventionally uses. Neither is what WebCrypto
 * wants, so this module is the adapter between them: COSE map to JWK, and — the
 * detail that silently breaks naive implementations — ASN.1 DER ECDSA
 * signatures to the raw r‖s pair WebCrypto verifies.
 *
 * Two algorithms are supported and the rest are refused by name. ES256 is
 * universal; RS256 covers the TPM-backed Windows Hello case. Accepting an
 * algorithm we have not exercised would mean trusting an unverified code path
 * with the login.
 */

import { CborError, type CborMap, decodeCbor } from "./cbor.ts";
import { base64Url } from "../encoding.ts";

export class CoseError extends Error {
  override readonly name = "CoseError";
}

/** COSE_Key common parameters (RFC 8152 §7.1) and the algorithm labels we take. */
const KTY = 1;
const ALG = 3;
const KTY_EC2 = 2;
const KTY_RSA = 3;
const ALG_ES256 = -7;
const ALG_RS256 = -257;
const CRV_P256 = 1;

export const SUPPORTED_ALGORITHMS: readonly number[] = [ALG_ES256, ALG_RS256];

export interface CoseKey {
  readonly algorithm: number;
  readonly key: CryptoKey;
}

function integerAt(map: CborMap, label: number, what: string): number {
  const value = map.get(label);
  if (typeof value !== "number") throw new CoseError(`COSE key has no integer ${what}`);
  return value;
}

function bytesAt(map: CborMap, label: number, what: string): Uint8Array {
  const value = map.get(label);
  if (!(value instanceof Uint8Array)) throw new CoseError(`COSE key has no ${what}`);
  return value;
}

/**
 * Import the credential public key exactly as the authenticator encoded it. The
 * COSE bytes are what we store; this runs on every verification rather than at
 * registration, so nothing lossy is ever persisted in their place.
 */
export async function importCoseKey(cose: Uint8Array): Promise<CoseKey> {
  let map: CborMap;
  try {
    const decoded = decodeCbor(cose);
    if (!(decoded instanceof Map)) throw new CoseError("COSE key is not a map");
    map = decoded;
  } catch (error) {
    if (error instanceof CborError) throw new CoseError(`Malformed COSE key: ${error.message}`);
    throw error;
  }

  const algorithm = integerAt(map, ALG, "alg");
  const kty = integerAt(map, KTY, "kty");

  if (algorithm === ALG_ES256) {
    if (kty !== KTY_EC2) throw new CoseError("ES256 key is not an EC2 key");
    if (integerAt(map, -1, "crv") !== CRV_P256) throw new CoseError("ES256 key is not on P-256");
    const x = bytesAt(map, -2, "x coordinate");
    const y = bytesAt(map, -3, "y coordinate");
    if (x.length !== 32 || y.length !== 32) {
      throw new CoseError("P-256 coordinates must be 32 bytes each");
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: base64Url(x), y: base64Url(y), ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return { algorithm, key };
  }

  if (algorithm === ALG_RS256) {
    if (kty !== KTY_RSA) throw new CoseError("RS256 key is not an RSA key");
    const n = bytesAt(map, -1, "modulus");
    const e = bytesAt(map, -2, "exponent");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: base64Url(n), e: base64Url(e), ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return { algorithm, key };
  }

  throw new CoseError(
    `Unsupported COSE algorithm ${algorithm}. This application verifies ES256 and RS256 only.`,
  );
}

/**
 * ECDSA signatures arrive DER-encoded — `SEQUENCE { INTEGER r, INTEGER s }` —
 * while WebCrypto verifies the raw fixed-width pair. DER integers are signed, so
 * a value whose top bit is set carries a leading zero byte that must come off,
 * and a short value must be left-padded back to 32 bytes.
 */
export function derToRawEcdsaSignature(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new CoseError("ECDSA signature is not a DER SEQUENCE");
  }
  // Lengths here are always short-form: a P-256 signature never reaches 128 bytes.
  if (der[1] !== der.length - 2) throw new CoseError("DER SEQUENCE length does not match");

  const readInteger = (offset: number): { value: Uint8Array; next: number } => {
    if (der[offset] !== 0x02) throw new CoseError("Expected a DER INTEGER in the signature");
    const length = der[offset + 1]!;
    const start = offset + 2;
    if (length === 0 || start + length > der.length) throw new CoseError("Malformed DER INTEGER");
    let value = der.subarray(start, start + length);
    // Strip the sign byte DER adds to keep the integer positive.
    while (value.length > 1 && value[0] === 0x00) value = value.subarray(1);
    if (value.length > 32) throw new CoseError("DER INTEGER is too large for P-256");
    return { value, next: start + length };
  };

  const r = readInteger(2);
  const s = readInteger(r.next);
  if (s.next !== der.length) throw new CoseError("Trailing bytes after the DER signature");

  const raw = new Uint8Array(64);
  raw.set(r.value, 32 - r.value.length);
  raw.set(s.value, 64 - s.value.length);
  return raw;
}

/** Verify `signature` over `data` with an imported credential key. */
export async function verifyCoseSignature(
  cose: CoseKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (cose.algorithm === ALG_ES256) {
    let raw: Uint8Array;
    try {
      raw = derToRawEcdsaSignature(signature);
    } catch {
      // A signature we cannot even parse is a failed verification, not a crash.
      return false;
    }
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cose.key,
      raw as BufferSource,
      data as BufferSource,
    );
  }
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cose.key,
    signature as BufferSource,
    data as BufferSource,
  );
}
