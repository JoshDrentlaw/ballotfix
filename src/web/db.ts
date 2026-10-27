/**
 * The app's one SQLite file (data/ballotfix.db), through Deno's built-in
 * node:sqlite: no native download and no permission beyond reading and
 * writing the data directory.
 *
 * Runs, ballots, and choices are stored as JSON bodies, one row each, so
 * their shapes stay defined in TypeScript as before. The knowledge graph
 * (src/knowledge.ts) is stored as real tables, derived from finished runs.
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * Schema changes, in order. Applied ones are counted in PRAGMA user_version;
 * add new steps at the end and never edit an applied one.
 */
const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

  CREATE TABLE runs (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL
  ) STRICT;
  CREATE INDEX runs_by_created ON runs (created_at);
  CREATE INDEX runs_by_status ON runs (status);

  CREATE TABLE ballots (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL) STRICT;
  CREATE INDEX ballots_by_created ON ballots (created_at);

  -- The voter's notes and picks: their own table, so saving a run never touches them.
  CREATE TABLE choices (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL) STRICT;

  -- Knowledge graph. Everything below is rebuilt from finished runs on demand.
  CREATE TABLE entities (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL
  ) STRICT;

  -- One row per page, keyed by the normalized URL.
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY, url_key TEXT NOT NULL UNIQUE, url TEXT NOT NULL
  ) STRICT;

  CREATE TABLE claims (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    section TEXT NOT NULL,
    position INTEGER NOT NULL,
    statement TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    verified INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX claims_by_run ON claims (run_id);

  -- Provenance as the dossier reported it, per claim and page.
  CREATE TABLE citations (
    claim_id INTEGER NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources (id),
    source_name TEXT NOT NULL,
    author TEXT,
    published TEXT,
    PRIMARY KEY (claim_id, source_id)
  ) STRICT;
  CREATE INDEX citations_by_source ON citations (source_id);

  -- Which entities a claim is about ("subject") or names (later steps).
  CREATE TABLE claim_entities (
    claim_id INTEGER NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities (id),
    role TEXT NOT NULL,
    PRIMARY KEY (claim_id, entity_id, role)
  ) STRICT;
  CREATE INDEX claim_entities_by_entity ON claim_entities (entity_id);

  CREATE TABLE relations (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES entities (id),
    relation TEXT NOT NULL,
    object_id INTEGER NOT NULL REFERENCES entities (id),
    detail TEXT,
    UNIQUE (run_id, subject_id, relation, object_id)
  ) STRICT;
  CREATE INDEX relations_by_subject ON relations (subject_id);
  CREATE INDEX relations_by_object ON relations (object_id);
  `,
  `
  -- The voter's issue a priority_n claim answers: priority_1 is a different issue in each run.
  ALTER TABLE claims ADD COLUMN issue TEXT;

  -- Lets the startup check find ballots still being read without parsing every reading.
  ALTER TABLE ballots ADD COLUMN status TEXT NOT NULL DEFAULT '';
  UPDATE ballots SET status = coalesce(json_extract(body, '$.status'), '');
  CREATE INDEX ballots_by_status ON ballots (status);
  `,
];

export type Row = Record<string, unknown>;

export class Db {
  readonly #sql: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  /** `path` is a file, or ":memory:". */
  constructor(path: string) {
    this.#sql = new DatabaseSync(path);
    this.#sql.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.#migrate();
  }

  #migrate(): void {
    const at = Number((this.get("PRAGMA user_version") as Row).user_version);
    for (let v = at; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.#sql.exec(MIGRATIONS[v]);
        this.#sql.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Prepared once per SQL string, then reused. */
  #stmt(sql: string): StatementSync {
    let s = this.#statements.get(sql);
    if (!s) {
      s = this.#sql.prepare(sql);
      this.#statements.set(sql, s);
    }
    return s;
  }

  /** Returns how many rows changed. */
  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#stmt(sql).run(...params).changes);
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#stmt(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#stmt(sql).all(...params) as Row[];
  }

  #depth = 0;

  /**
   * Runs `fn` in one transaction: all of it lands or none of it does, and a
   * batch of writes costs one disk sync. A nested call is a savepoint inside
   * the outer transaction, so its failure undoes only its own writes and the
   * caller can catch it and go on.
   */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.#depth}`;
    const nested = this.#sql.isTransaction;
    this.#sql.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const out = fn();
      this.#sql.exec(nested ? `RELEASE ${sp}` : "COMMIT");
      return out;
    } catch (err) {
      this.#sql.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
      throw err;
    } finally {
      this.#depth--;
    }
  }

  meta(key: string): string | null {
    const r = this.get("SELECT value FROM meta WHERE key = ?", key);
    return r ? String(r.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  close(): void {
    this.#statements.clear();
    this.#sql.close();
  }
}
