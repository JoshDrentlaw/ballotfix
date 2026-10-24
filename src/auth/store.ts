/**
 * Auth state on disk: registered passkeys and live sessions, in one JSON file
 * under the data directory (`data/auth/auth.json`). Like the run store, there
 * is no database; the state is tiny and changes only on sign-in, sign-out and
 * passkey edits.
 *
 * The file is loaded once and kept in memory. Every change goes through
 * `update`, which serialises writes so two requests can't interleave a
 * read-modify-write, and saves atomically (temp file, then rename).
 *
 * The subdirectory matters: `RunStore.list()` reads every `*.json` directly in
 * the data directory as a run, and skips directories.
 */

import { base64Url } from "./encoding.ts";

/** A registered authenticator. The public key is not a secret; the label is the owner's. */
export interface Credential {
  readonly id: string;
  readonly credentialId: string;
  /** The COSE key verbatim, base64url. */
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly aaguid: string | null;
  readonly backedUp: boolean;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** A signed-in browser. `id` is the SHA-256 of the cookie token, never the token itself. */
export interface Session {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly absoluteExpiresAt: string;
  readonly userAgent: string | null;
}

export interface AuthState {
  /**
   * The opaque user handle the authenticator stores with a discoverable
   * credential. There is one owner, so there is one handle, made once.
   */
  userHandle: string;
  credentials: Credential[];
  sessions: Session[];
}

export class AuthStore {
  readonly #path: string;
  #state: AuthState | null = null;
  #writes: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {
    this.#path = `${dir}/auth.json`;
  }

  async init(): Promise<void> {
    await Deno.mkdir(this.dir, { recursive: true });
    try {
      this.#state = JSON.parse(await Deno.readTextFile(this.#path)) as AuthState;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      this.#state = {
        userHandle: base64Url(crypto.getRandomValues(new Uint8Array(16))),
        credentials: [],
        sessions: [],
      };
      await this.#save(this.#state);
    }
  }

  /** The current state. Treat it as read-only; change it through `update`. */
  get state(): Readonly<AuthState> {
    if (!this.#state) throw new Error("AuthStore.init() has not run");
    return this.#state;
  }

  /** Apply a change and persist it. Changes run one at a time, in call order. */
  update<T>(change: (state: AuthState) => T): Promise<T> {
    const run = this.#writes.then(async () => {
      const state = structuredClone(this.state) as AuthState;
      const result = change(state);
      await this.#save(state);
      this.#state = state;
      return result;
    });
    this.#writes = run.then(() => {}, () => {});
    return run;
  }

  async #save(state: AuthState): Promise<void> {
    const tmp = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(state, null, 2));
    await Deno.rename(tmp, this.#path);
  }
}
