/**
 * Writes the knowledge graph (src/knowledge.ts) to SQLite and reads it back.
 * Indexing is local work only: it never calls a model or the network.
 */

import {
  type EntityKind,
  KNOWLEDGE_VERSION,
  type Projection,
  projectMeasure,
  projectRace,
  type Relation,
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
  statement: string;
  evidence_type: EvidenceType;
  verified: boolean;
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

export interface KnowledgeStats {
  entities: number;
  claims: number;
  sources: number;
  relations: number;
}

/** What a finished run contributes to the graph; nothing for an unfinished one. */
export function projectRun(run: RunRecord): Projection | null {
  if (run.status !== "done") return null;
  if (run.measure) return run.measure_result ? projectMeasure(run.measure_result) : null;
  return run.race ? projectRace(run.race) : null;
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
   * Replaces what one run contributes. Called inside the transaction that
   * saves the run, so the graph never disagrees with the saved runs.
   */
  indexRun(run: RunRecord): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM claims WHERE run_id = ?", run.id);
      this.db.run("DELETE FROM relations WHERE run_id = ?", run.id);
      const p = projectRun(run);
      if (p) this.#write(run.id, p);
    });
  }

  #write(runId: string, p: Projection): void {
    const ids = new Map<string, number>();
    const entityId = (key: string): number => {
      const id = ids.get(key);
      if (id === undefined) throw new Error(`projection names an unlisted entity: ${key}`);
      return id;
    };
    for (const e of p.entities) {
      // DO UPDATE (a no-op) rather than DO NOTHING so RETURNING yields the existing id.
      const r = this.db.get(
        `INSERT INTO entities (kind, key, name) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET key = excluded.key RETURNING id`,
        e.kind,
        e.key,
        e.name,
      )!;
      ids.set(e.key, Number(r.id));
    }
    for (const c of p.claims) {
      const claim = Number(
        this.db.get(
          `INSERT INTO claims (run_id, section, position, statement, evidence_type, verified)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          runId,
          c.section,
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
      for (const cite of c.citations) {
        const source = Number(
          this.db.get(
            `INSERT INTO sources (url_key, url) VALUES (?, ?)
             ON CONFLICT (url_key) DO UPDATE SET url_key = excluded.url_key RETURNING id`,
            cite.url_key,
            cite.url,
          )!.id,
        );
        this.db.run(
          `INSERT INTO citations (claim_id, source_id, source_name, author, published)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          claim,
          source,
          cite.source_name,
          cite.author,
          cite.published,
        );
      }
    }
    for (const r of p.relations) {
      this.db.run(
        `INSERT INTO relations (run_id, subject_id, relation, object_id, detail)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        runId,
        entityId(r.subject),
        r.relation,
        entityId(r.object),
        r.detail,
      );
    }
  }

  /**
   * Rebuilds the whole graph from the saved runs, in one transaction. Runs on
   * start when KNOWLEDGE_VERSION changed or old JSON files were imported.
   */
  rebuild(): number {
    return this.db.tx(() => {
      for (
        const t of ["claim_entities", "citations", "claims", "relations", "sources", "entities"]
      ) {
        this.db.run(`DELETE FROM ${t}`);
      }
      let n = 0;
      for (const r of this.db.all("SELECT body FROM runs WHERE status = 'done'")) {
        let run: RunRecord;
        try {
          run = JSON.parse(String(r.body));
        } catch {
          continue;
        }
        this.indexRun(run);
        n++;
      }
      this.db.setMeta("knowledge_version", String(KNOWLEDGE_VERSION));
      return n;
    });
  }

  get upToDate(): boolean {
    return this.db.meta("knowledge_version") === String(KNOWLEDGE_VERSION);
  }

  entity(key: string): Entity | null {
    const r = this.db.get("SELECT id, kind, key, name FROM entities WHERE key = ?", key);
    return r ? toEntity(r) : null;
  }

  /** Claims about an entity, across every run, newest run first, in dossier order. */
  claimsAbout(entityId: number): StoredClaim[] {
    const rows = this.db.all(
      `SELECT c.id, c.run_id, c.section, c.statement, c.evidence_type, c.verified,
              s.url, ci.source_name, ci.author, ci.published
       FROM claim_entities ce
       JOIN claims c ON c.id = ce.claim_id
       JOIN runs r ON r.id = c.run_id
       JOIN citations ci ON ci.claim_id = c.id
       JOIN sources s ON s.id = ci.source_id
       WHERE ce.entity_id = ?
       ORDER BY r.created_at DESC, c.id, s.id`,
      entityId,
    );
    const out: StoredClaim[] = [];
    for (const r of rows) {
      const id = Number(r.id);
      let claim = out.at(-1);
      if (claim?.id !== id) {
        claim = {
          id,
          run_id: String(r.run_id),
          section: String(r.section),
          statement: String(r.statement),
          evidence_type: r.evidence_type as EvidenceType,
          verified: Number(r.verified) === 1,
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
