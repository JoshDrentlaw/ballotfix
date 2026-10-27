/**
 * Writes the knowledge graph (src/knowledge.ts) to SQLite and reads it back.
 * Indexing is local work only: it never calls a model or the network.
 */

import {
  type ContributionDetail,
  type EntityKind,
  KNOWLEDGE_VERSION,
  type Projection,
  projectMeasure,
  projectRace,
  type Relation,
  SUPPORT_SECTIONS,
} from "../knowledge.ts";
import type { EvidenceType } from "../types.ts";
import type { Db, Row } from "./db.ts";
import type { RunRecord } from "./store.ts";

export interface Entity {
  id: number;
  kind: EntityKind;
  key: string;
  name: string;
}

export interface StoredCitation {
  url: string;
  source_name: string;
  author: string | null;
  published: string | null;
}

export interface StoredClaim {
  id: number;
  run_id: string;
  section: string;
  /** For a priority_n section, the voter's issue it answers. */
  issue: string | null;
  statement: string;
  evidence_type: EvidenceType;
  verified: boolean;
  /** "subject": the claim is about this entity; "named": its statement names it. */
  role: string;
  citations: StoredCitation[];
}

export interface Link {
  relation: Relation;
  /** "out": this entity is the subject; "in": it is the object. */
  direction: "out" | "in";
  other: Entity;
  run_id: string;
  detail: string | null;
}

/** How an entity is tied to one side of a comparison. */
export type Tie =
  | {
    kind: "contribution";
    run_id: string;
    detail: ContributionDetail;
    citations: StoredCitation[];
  }
  | {
    /** Named in a verified claim in a SUPPORT_SECTIONS section about that side. */
    kind: "named";
    run_id: string;
    section: string;
    statement: string;
    citations: StoredCitation[];
  };

/** An entity tied to both sides of a comparison, with every tie and its source. */
export interface SharedConnection {
  entity: Entity;
  a: Tie[];
  b: Tie[];
}

export interface KnowledgeStats {
  entities: number;
  claims: number;
  sources: number;
  relations: number;
}

/** What a finished run contributes to the graph; nothing for an unfinished one. */
export function projectRun(run: RunRecord): Projection | null {
  if (run.status !== "done") return null;
  if (run.measure) return run.measure_result ? projectMeasure(run.measure_result, run.id) : null;
  return run.race ? projectRace(run.race, run.id) : null;
}

const toEntity = (r: Row): Entity => ({
  id: Number(r.id),
  kind: r.kind as EntityKind,
  key: String(r.key),
  name: String(r.name),
});

const strOrNull = (v: unknown) => v === null || v === undefined ? null : String(v);

export class KnowledgeBase {
  constructor(readonly db: Db) {}

  /**
   * Replaces what one run contributes, all or nothing. If it throws, the
   * graph still holds the run's previous contribution; see forgetRun.
   */
  indexRun(run: RunRecord): void {
    this.db.tx(() => {
      const before = this.#referencedBy(run.id);
      this.#clear(run.id);
      const p = projectRun(run);
      if (p) this.#write(run.id, p);
      this.#prune(before);
    });
  }

  /** Removes what one run contributes, e.g. after indexRun failed on it. */
  forgetRun(runId: string): void {
    this.db.tx(() => {
      const before = this.#referencedBy(runId);
      this.#clear(runId);
      this.#prune(before);
    });
  }

  #clear(runId: string): void {
    this.db.run("DELETE FROM claims WHERE run_id = ?", runId);
    this.db.run("DELETE FROM relations WHERE run_id = ?", runId);
  }

  #referencedBy(runId: string): { entities: number[]; sources: number[] } {
    const ids = (rows: Row[]) => rows.map((r) => Number(r.id));
    return {
      entities: ids(this.db.all(
        `SELECT ce.entity_id AS id FROM claim_entities ce JOIN claims c ON c.id = ce.claim_id
         WHERE c.run_id = ?1
         UNION SELECT subject_id FROM relations WHERE run_id = ?1
         UNION SELECT object_id FROM relations WHERE run_id = ?1`,
        runId,
      )),
      sources: ids(this.db.all(
        `SELECT ci.source_id AS id FROM citations ci JOIN claims c ON c.id = ci.claim_id
         WHERE c.run_id = ?1
         UNION SELECT rc.source_id FROM relation_citations rc
         JOIN relations rel ON rel.id = rc.relation_id WHERE rel.run_id = ?1`,
        runId,
      )),
    };
  }

  /** Drops the given entities and sources if nothing refers to them any more. */
  #prune(candidates: { entities: number[]; sources: number[] }): void {
    for (const id of candidates.entities) {
      this.db.run(
        `DELETE FROM entities WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM claim_entities WHERE entity_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM relations WHERE subject_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM relations WHERE object_id = ?1)`,
        id,
      );
    }
    for (const id of candidates.sources) {
      this.db.run(
        `DELETE FROM sources WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM citations WHERE source_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM relation_citations WHERE source_id = ?1)`,
        id,
      );
    }
  }

  #write(runId: string, p: Projection): void {
    const ids = new Map<string, number>();
    const entityId = (key: string): number => {
      const id = ids.get(key);
      if (id === undefined) throw new Error(`projection names an unlisted entity: ${key}`);
      return id;
    };
    for (const e of p.entities) {
      // The latest indexed run names the entity (rebuild goes oldest to newest),
      // and DO UPDATE, unlike DO NOTHING, makes RETURNING yield the existing id.
      const r = this.db.get(
        `INSERT INTO entities (kind, key, name) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET name = excluded.name RETURNING id`,
        e.kind,
        e.key,
        e.name,
      )!;
      ids.set(e.key, Number(r.id));
    }
    for (const c of p.claims) {
      const claim = Number(
        this.db.get(
          `INSERT INTO claims (run_id, section, issue, position, statement, evidence_type, verified)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          runId,
          c.section,
          c.issue,
          c.position,
          c.statement,
          c.evidence_type,
          c.verified ? 1 : 0,
        )!.id,
      );
      this.db.run(
        "INSERT INTO claim_entities (claim_id, entity_id, role) VALUES (?, ?, 'subject')",
        claim,
        entityId(c.subject),
      );
      for (const key of c.also_about ?? []) {
        this.db.run(
          `INSERT INTO claim_entities (claim_id, entity_id, role) VALUES (?, ?, 'subject')
           ON CONFLICT DO NOTHING`,
          claim,
          entityId(key),
        );
      }
      for (const key of c.named) {
        this.db.run(
          `INSERT INTO claim_entities (claim_id, entity_id, role) VALUES (?, ?, 'named')
           ON CONFLICT DO NOTHING`,
          claim,
          entityId(key),
        );
      }
      for (const cite of c.citations) {
        this.db.run(
          `INSERT INTO citations (claim_id, source_id, source_name, author, published)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          claim,
          this.#source(cite),
          cite.source_name,
          cite.author,
          cite.published,
        );
      }
    }
    for (const r of p.relations) {
      const rel = this.db.get(
        `INSERT INTO relations (run_id, subject_id, relation, object_id, detail)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
        runId,
        entityId(r.subject),
        r.relation,
        entityId(r.object),
        r.detail,
      );
      // A relation is only ever cited when it was written: an exact repeat adds nothing.
      if (!rel) continue;
      for (const cite of r.citations ?? []) {
        this.db.run(
          `INSERT INTO relation_citations (relation_id, source_id, source_name, author, published)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          Number(rel.id),
          this.#source(cite),
          cite.source_name,
          cite.author,
          cite.published,
        );
      }
    }
  }

  /** One source row per page. */
  #source(cite: { url_key: string; url: string }): number {
    return Number(
      this.db.get(
        `INSERT INTO sources (url_key, url) VALUES (?, ?)
         ON CONFLICT (url_key) DO UPDATE SET url_key = excluded.url_key RETURNING id`,
        cite.url_key,
        cite.url,
      )!.id,
    );
  }

  /**
   * Rebuilds the whole graph from the saved runs, oldest first, in one
   * transaction. Runs on start when KNOWLEDGE_VERSION changed or old JSON
   * files were imported. A run that can't be indexed is skipped and logged,
   * never fatal: the graph is derived data, and the app must still start.
   */
  rebuild(log: (msg: string) => void = () => {}): { indexed: number; skipped: number } {
    return this.db.tx(() => {
      for (
        const t of [
          "claim_entities",
          "citations",
          "claims",
          "relation_citations",
          "relations",
          "sources",
          "entities",
        ]
      ) {
        this.db.run(`DELETE FROM ${t}`);
      }
      let indexed = 0, skipped = 0;
      const rows = this.db.all(
        "SELECT id, body FROM runs WHERE status = 'done' ORDER BY created_at, id",
      );
      for (const r of rows) {
        try {
          this.indexRun(JSON.parse(String(r.body)));
          indexed++;
        } catch (err) {
          skipped++;
          log(`Could not add run ${r.id} to the knowledge graph: ${err}`);
        }
      }
      this.db.setMeta("knowledge_version", String(KNOWLEDGE_VERSION));
      return { indexed, skipped };
    });
  }

  get upToDate(): boolean {
    return this.db.meta("knowledge_version") === String(KNOWLEDGE_VERSION);
  }

  entity(key: string): Entity | null {
    const r = this.db.get("SELECT id, kind, key, name FROM entities WHERE key = ?", key);
    return r ? toEntity(r) : null;
  }

  /**
   * Claims about an entity, or naming it, across every run, newest run first,
   * in dossier order. A claim both about and naming it appears once per role.
   */
  claimsAbout(entityId: number): StoredClaim[] {
    const rows = this.db.all(
      `SELECT c.id, c.run_id, c.section, c.issue, c.statement, c.evidence_type, c.verified,
              ce.role, s.url, ci.source_name, ci.author, ci.published
       FROM claim_entities ce
       JOIN claims c ON c.id = ce.claim_id
       JOIN runs r ON r.id = c.run_id
       JOIN citations ci ON ci.claim_id = c.id
       JOIN sources s ON s.id = ci.source_id
       WHERE ce.entity_id = ?
       ORDER BY r.created_at DESC, c.id, ce.role, s.id`,
      entityId,
    );
    const out: StoredClaim[] = [];
    for (const r of rows) {
      const id = Number(r.id);
      let claim = out.at(-1);
      if (claim?.id !== id || claim.role !== String(r.role)) {
        claim = {
          id,
          run_id: String(r.run_id),
          section: String(r.section),
          issue: strOrNull(r.issue),
          statement: String(r.statement),
          evidence_type: r.evidence_type as EvidenceType,
          verified: Number(r.verified) === 1,
          role: String(r.role),
          citations: [],
        };
        out.push(claim);
      }
      claim.citations.push({
        url: String(r.url),
        source_name: String(r.source_name),
        author: strOrNull(r.author),
        published: strOrNull(r.published),
      });
    }
    return out;
  }

  /** Every relation the entity takes part in, either side. */
  linksOf(entityId: number): Link[] {
    const rows = this.db.all(
      `SELECT rel.relation, rel.run_id, rel.detail, 'out' AS direction,
              e.id, e.kind, e.key, e.name
       FROM relations rel JOIN entities e ON e.id = rel.object_id WHERE rel.subject_id = ?1
       UNION ALL
       SELECT rel.relation, rel.run_id, rel.detail, 'in' AS direction,
              e.id, e.kind, e.key, e.name
       FROM relations rel JOIN entities e ON e.id = rel.subject_id WHERE rel.object_id = ?1
       ORDER BY e.name`,
      entityId,
    );
    return rows.map((r) => ({
      relation: r.relation as Relation,
      direction: r.direction as "out" | "in",
      other: toEntity(r),
      run_id: String(r.run_id),
      detail: strOrNull(r.detail),
    }));
  }

  /**
   * Everyone tied to an entity by money or support, across every run: who
   * contributed to it (contributed_to, with the filing's words and page), and
   * who verified claims about it in SUPPORT_SECTIONS name. Keyed by entity id.
   */
  tiesOf(entityId: number): Map<number, { entity: Entity; ties: Tie[] }> {
    const out = new Map<number, { entity: Entity; ties: Tie[] }>();
    const add = (r: Row, tie: Tie) => {
      const e = toEntity(r);
      const got = out.get(e.id) ?? { entity: e, ties: [] };
      got.ties.push(tie);
      out.set(e.id, got);
    };
    const cites = (rows: Row[]) =>
      rows.map((c) => ({
        url: String(c.url),
        source_name: String(c.source_name),
        author: strOrNull(c.author),
        published: strOrNull(c.published),
      }));
    for (
      const r of this.db.all(
        `SELECT rel.id AS rel_id, rel.run_id, rel.detail, e.id, e.kind, e.key, e.name
         FROM relations rel JOIN entities e ON e.id = rel.subject_id
         WHERE rel.relation = 'contributed_to' AND rel.object_id = ?
         ORDER BY rel.id`,
        entityId,
      )
    ) {
      add(r, {
        kind: "contribution",
        run_id: String(r.run_id),
        detail: JSON.parse(String(r.detail)) as ContributionDetail,
        citations: cites(this.db.all(
          `SELECT s.url, rc.source_name, rc.author, rc.published FROM relation_citations rc
           JOIN sources s ON s.id = rc.source_id WHERE rc.relation_id = ? ORDER BY s.id`,
          Number(r.rel_id),
        )),
      });
    }
    const sections = SUPPORT_SECTIONS.map((x) => `'${x}'`).join(", ");
    for (
      const r of this.db.all(
        `SELECT c.id AS claim_id, c.run_id, c.section, c.statement, e.id, e.kind, e.key, e.name
         FROM claim_entities about
         JOIN claims c ON c.id = about.claim_id
         JOIN claim_entities n ON n.claim_id = c.id AND n.role = 'named'
         JOIN entities e ON e.id = n.entity_id
         WHERE about.entity_id = ? AND about.role = 'subject' AND c.verified = 1
           AND c.section IN (${sections})
         ORDER BY c.id`,
        entityId,
      )
    ) {
      add(r, {
        kind: "named",
        run_id: String(r.run_id),
        section: String(r.section),
        statement: String(r.statement),
        citations: cites(this.db.all(
          `SELECT s.url, ci.source_name, ci.author, ci.published FROM citations ci
           JOIN sources s ON s.id = ci.source_id WHERE ci.claim_id = ? ORDER BY s.id`,
          Number(r.claim_id),
        )),
      });
    }
    return out;
  }

  /**
   * The contributors and endorsers two entities share: every entity tied to
   * both (tiesOf), by entity identity only. Entity keys carry their scope, so
   * two subjects in one jurisdiction only ever share that jurisdiction's
   * entities; nothing is matched on name here.
   */
  sharedBetween(aId: number, bId: number): SharedConnection[] {
    const a = this.tiesOf(aId), b = this.tiesOf(bId);
    return [...a.values()].flatMap((x) => {
      const y = b.get(x.entity.id);
      return y && x.entity.id !== aId && x.entity.id !== bId
        ? [{ entity: x.entity, a: x.ties, b: y.ties }]
        : [];
    }).sort((p, q) => p.entity.name.localeCompare(q.entity.name));
  }

  stats(): KnowledgeStats {
    const n = (t: string) => Number(this.db.get(`SELECT count(*) AS n FROM ${t}`)!.n);
    return {
      entities: n("entities"),
      claims: n("claims"),
      sources: n("sources"),
      relations: n("relations"),
    };
  }
}
