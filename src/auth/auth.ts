/**
 * Sign-in for the one person who runs this app: a password (BALLOTFIX_PASSWORD)
 * and, once registered from a signed-in session, passkeys. Ported from
 * job-radar's auth (sessions, passkey service, backoff), cut down to a single
 * owner and file storage.
 *
 * - Sessions: the cookie carries a random token; only its SHA-256 is stored, so
 *   reading `data/` does not hand anyone a working session. Idle timeout plus an
 *   absolute cap, individually revocable.
 * - Passkeys: discoverable credentials with user verification required, so
 *   signing in needs no username and a passkey is a complete credential.
 *   Challenges are single-use: consuming one is a synchronous get-and-delete,
 *   which nothing can interleave in a single-threaded process.
 * - Backoff: failed password and passkey attempts share one ladder, so
 *   switching method doesn't reset it.
 */

import { randomToken, sha256Hex, timingSafeEqual } from "./encoding.ts";
import {
  type AuthenticationResponse,
  type ExpectedOrigin,
  type RegistrationResponse,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
} from "./webauthn/ceremony.ts";
import { SUPPORTED_ALGORITHMS } from "./webauthn/cose.ts";
import type { AuthStore, Credential, Session } from "./store.ts";

export { WebAuthnError };

export const SESSION_COOKIE = "ballotfix_session";
/** Total lifetime, regardless of activity. */
export const ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** Inactivity that ends a session early. */
export const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** `lastSeenAt` is only rewritten when it is this stale, so browsing isn't a write per page. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Long enough to survive a fingerprint retry, short enough to be worthless later. */
export const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
/**
 * Sign-in challenges are issued to anyone who asks, so the outstanding set is
 * capped; past the cap the oldest go first.
 */
const MAX_OUTSTANDING_CHALLENGES = 64;

/** Failures older than this stop counting, so backing off restores the budget. */
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;
/** Free attempts before backoff engages. */
export const FREE_ATTEMPTS = 3;
/** Then 5s, 15s, 60s, 5m, 15m, and 60m for every failure beyond that. */
const BACKOFF_LADDER_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export function backoffForFailureCount(failures: number): number {
  const overage = failures - FREE_ATTEMPTS;
  if (overage <= 0) return 0;
  return BACKOFF_LADDER_MS[Math.min(overage - 1, BACKOFF_LADDER_MS.length - 1)];
}

/**
 * The relying party id and origin come from configuration (BALLOTFIX_BASE_URL),
 * never from the request, which the client controls. That mismatch check is the
 * whole defence against a credential being used from another site.
 *
 * Browsers only allow WebAuthn in a secure context: HTTPS, or localhost. For
 * any other origin this returns null and passkeys stay off.
 */
export function expectedOriginFrom(baseUrl: string | undefined): ExpectedOrigin | null {
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
  return { rpId: url.hostname, origin: url.origin };
}

type ChallengePurpose = "register" | "authenticate";

export interface AuthOptions {
  password: string;
  /** Null when passkeys are unavailable (no secure BALLOTFIX_BASE_URL). */
  expected: ExpectedOrigin | null;
  now?: () => Date;
}

export class Auth {
  readonly #store: AuthStore;
  readonly #password: string;
  readonly #now: () => Date;
  readonly expected: ExpectedOrigin | null;
  readonly #challenges = new Map<string, { purpose: ChallengePurpose; expiresAt: number }>();
  /** Recent failure times, oldest first. In memory: a restart forgives, which is fine here. */
  #failures: number[] = [];

  constructor(store: AuthStore, opts: AuthOptions) {
    this.#store = store;
    this.#password = opts.password;
    this.expected = opts.expected;
    this.#now = opts.now ?? (() => new Date());
  }

  /* ------------------------------------------------ backoff ------------- */

  /** Seconds until another attempt is allowed; 0 means go ahead. */
  retryAfterSeconds(): number {
    const now = this.#now().getTime();
    this.#failures = this.#failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    const backoff = backoffForFailureCount(this.#failures.length);
    if (backoff === 0) return 0;
    const remaining = this.#failures[this.#failures.length - 1] + backoff - now;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  #recordFailure(): void {
    this.#failures.push(this.#now().getTime());
  }

  /* ------------------------------------------------ password ------------ */

  /** Check the password. Callers check `retryAfterSeconds()` first. */
  checkPassword(candidate: string): boolean {
    const ok = timingSafeEqual(candidate, this.#password);
    if (ok) this.#failures = [];
    else this.#recordFailure();
    return ok;
  }

  /* ------------------------------------------------ sessions ------------ */

  /** Start a session. The returned token goes in the cookie and is never stored. */
  async issueSession(userAgent: string | null): Promise<string> {
    const token = randomToken(32);
    const now = this.#now();
    const session: Session = {
      id: await sha256Hex(token),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_LIFETIME_MS).toISOString(),
      userAgent: userAgent?.slice(0, 200) ?? null,
    };
    await this.#store.update((s) => {
      s.sessions = s.sessions.filter((x) => this.#live(x, now)).concat(session);
    });
    return token;
  }

  #live(s: Session, now: Date): boolean {
    const t = now.getTime();
    return t < Date.parse(s.absoluteExpiresAt) && t < Date.parse(s.lastSeenAt) + IDLE_TIMEOUT_MS;
  }

  /** Whether a cookie token belongs to a live session. Expired sessions are dropped. */
  async validSession(token: string): Promise<boolean> {
    if (!token) return false;
    const id = await sha256Hex(token);
    const session = this.#store.state.sessions.find((s) => s.id === id);
    if (!session) return false;
    const now = this.#now();
    if (!this.#live(session, now)) {
      await this.#store.update((s) => {
        s.sessions = s.sessions.filter((x) => x.id !== id);
      });
      return false;
    }
    if (now.getTime() - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS) {
      await this.#store.update((s) => {
        s.sessions = s.sessions.map((x) =>
          x.id === id ? { ...x, lastSeenAt: now.toISOString() } : x
        );
      });
    }
    return true;
  }

  async endSession(token: string): Promise<void> {
    if (!token) return;
    const id = await sha256Hex(token);
    await this.#store.update((s) => {
      s.sessions = s.sessions.filter((x) => x.id !== id);
    });
  }

  /** Sign out every browser, this one included. */
  async endAllSessions(): Promise<void> {
    await this.#store.update((s) => {
      s.sessions = [];
    });
  }

  sessionCount(): number {
    const now = this.#now();
    return this.#store.state.sessions.filter((s) => this.#live(s, now)).length;
  }

  /* ------------------------------------------------ challenges ---------- */

  #issueChallenge(purpose: ChallengePurpose): string {
    const now = this.#now().getTime();
    for (const [c, v] of this.#challenges) if (v.expiresAt <= now) this.#challenges.delete(c);
    while (this.#challenges.size >= MAX_OUTSTANDING_CHALLENGES) {
      this.#challenges.delete(this.#challenges.keys().next().value!);
    }
    const challenge = randomToken(32);
    this.#challenges.set(challenge, { purpose, expiresAt: now + CHALLENGE_LIFETIME_MS });
    return challenge;
  }

  /** Use a challenge up. True only the first time, for the purpose it was issued for. */
  #consumeChallenge(challenge: string, purpose: ChallengePurpose): boolean {
    const entry = this.#challenges.get(challenge);
    this.#challenges.delete(challenge);
    return entry !== undefined && entry.purpose === purpose &&
      entry.expiresAt > this.#now().getTime();
  }

  /* ------------------------------------------------ passkeys ------------ */

  #requireExpected(): ExpectedOrigin {
    if (!this.expected) throw new WebAuthnError("Passkeys aren't set up on this server.");
    return this.expected;
  }

  credentials(): readonly Credential[] {
    return this.#store.state.credentials;
  }

  /**
   * Options for `navigator.credentials.create`. `excludeCredentials` lists what
   * is already enrolled so a device can't register itself twice.
   */
  beginRegistration(): Record<string, unknown> {
    const expected = this.#requireExpected();
    return {
      challenge: this.#issueChallenge("register"),
      rp: { id: expected.rpId, name: "Ballot Fix" },
      user: {
        // Opaque, not a secret and not PII. Binary fields travel as base64url.
        id: this.#store.state.userHandle,
        name: "owner",
        displayName: "Ballot Fix owner",
      },
      pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
      timeout: CHALLENGE_LIFETIME_MS,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      excludeCredentials: this.credentials().map((c) => ({
        type: "public-key",
        id: c.credentialId,
        ...(c.transports.length > 0 ? { transports: c.transports } : {}),
      })),
    };
  }

  async finishRegistration(label: string, response: RegistrationResponse): Promise<Credential> {
    const verified = await verifyRegistration(response, this.#requireExpected());
    if (!this.#consumeChallenge(verified.challenge, "register")) {
      throw new WebAuthnError("That registration has expired or was already completed. Try again.");
    }
    if (this.credentials().some((c) => c.credentialId === verified.credentialId)) {
      throw new WebAuthnError("This device is already registered.");
    }
    const credential: Credential = {
      id: crypto.randomUUID(),
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      signCount: verified.signCount,
      transports: (Array.isArray(response.transports) ? response.transports : [])
        .filter((t) => typeof t === "string" && t.length < 32),
      aaguid: verified.aaguid,
      backedUp: verified.backedUp,
      label: cleanLabel(label),
      createdAt: this.#now().toISOString(),
      lastUsedAt: null,
    };
    await this.#store.update((s) => {
      s.credentials.push(credential);
    });
    return credential;
  }

  /**
   * Options for `navigator.credentials.get`. No `allowCredentials`: the
   * credential is discoverable, so the browser offers what it holds for this
   * site, and an unauthenticated caller never learns which ids are registered.
   * The response is the same whether or not any passkey exists.
   */
  beginAuthentication(): Record<string, unknown> {
    const expected = this.#requireExpected();
    return {
      challenge: this.#issueChallenge("authenticate"),
      rpId: expected.rpId,
      timeout: CHALLENGE_LIFETIME_MS,
      userVerification: "required",
    };
  }

  /** Verify a sign-in. Failures count toward the backoff, same as a wrong password. */
  async finishAuthentication(response: AuthenticationResponse): Promise<Credential> {
    try {
      return await this.#finishAuthentication(response);
    } catch (err) {
      this.#recordFailure();
      throw err;
    }
  }

  async #finishAuthentication(response: AuthenticationResponse): Promise<Credential> {
    const expected = this.#requireExpected();
    const credential = this.credentials().find((c) => c.credentialId === response.credentialId);
    if (!credential) throw new WebAuthnError("That passkey isn't registered here.");

    // When the authenticator reports the user handle, it must be the one we wrote.
    if (
      typeof response.userHandle === "string" && response.userHandle !== "" &&
      response.userHandle !== this.#store.state.userHandle
    ) {
      throw new WebAuthnError("That passkey belongs to a different account.");
    }

    const verified = await verifyAuthentication(response, credential, expected);
    if (!this.#consumeChallenge(verified.challenge, "authenticate")) {
      throw new WebAuthnError("That sign-in has expired or was already used. Try again.");
    }

    const now = this.#now().toISOString();
    await this.#store.update((s) => {
      s.credentials = s.credentials.map((c) =>
        c.id === credential.id ? { ...c, signCount: verified.signCount, lastUsedAt: now } : c
      );
    });
    this.#failures = [];
    return credential;
  }

  /** Rename a passkey. False if there is no such passkey. */
  rename(id: string, label: string): Promise<boolean> {
    return this.#store.update((s) => {
      const found = s.credentials.some((c) => c.id === id);
      s.credentials = s.credentials.map((c) =>
        c.id === id ? { ...c, label: cleanLabel(label) } : c
      );
      return found;
    });
  }

  /**
   * Remove a passkey. Removing the last one is fine: the password still works,
   * and there is no route that removes the password.
   */
  remove(id: string): Promise<boolean> {
    return this.#store.update((s) => {
      const before = s.credentials.length;
      s.credentials = s.credentials.filter((c) => c.id !== id);
      return s.credentials.length < before;
    });
  }
}

function cleanLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? "Passkey" : trimmed.slice(0, 60);
}
