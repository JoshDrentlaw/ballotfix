/**
 * Writes the knowledge graph (src/knowledge.ts) to SQLite and reads it back.
 * Indexing is local work only: it never calls a model or the network.
 */

import { createHash } from "node:crypto";
import {
  type ContributionDetail,
  type EntityKind,
  KNOWLEDGE_VERSION,
  nameKey,
  nearMisses,
  type PossibleMatch,
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
  /** Row id: renumbered by a rebuild, so never part of an address. */
  id: number;
  kind: EntityKind;
  key: string;
  name: string;
  /** The entity page's address (/entities/:slug): a hash of the key, stable across rebuilds. */
  slug: string;
  /** Normalized state and jurisdiction, as in the key. */
  scope: string;
  /** The place as the latest run wrote it, for display. */
  place: string;
}

/** The entity page's address for a key: the same key always gets the same slug. */
export function entitySlug(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/** A contribution as an entity page shows it: the filing's words, its pages, and its run. */
export interface StoredContribution {
  /** "made": this entity is the contributor; "received": it is the recipient. */
  direction: "made" | "received";
  other: Entity;
  run_id: string;
  detail: ContributionDetail;
  citations: StoredCitation[];
}

/** Two entities compared: what they share by identity, and the near misses kept apart. */
export interface GraphPair {
  shared: SharedConnection[];
  possible: PossibleMatch[];
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
export type GraphTie =
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

/** Everyone tied to an entity by money or support, by entity id (KnowledgeBase.tiesOf). */
export type Ties = Map<number, { entity: Entity; ties: GraphTie[] }>;

/** An entity tied to both sides of a comparison, with every tie and its source. */
export interface SharedConnection {
  entity: Entity;
  a: GraphTie[];
  b: GraphTie[];
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
  slug: String(r.slug),
  scope: String(r.scope),
  place: String(r.place),
});

/** The entity columns every query selects, as `e`. */
const E = "e.id, e.kind, e.key, e.name, e.slug, e.scope, e.place";

const toCitation = (r: Row): StoredCitation => ({
  url: String(r.url),
  source_name: String(r.source_name),
  author: strOrNull(r.author),
  published: strOrNull(r.published),
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
        `INSERT INTO entities (kind, key, name, slug, scope, place) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET name = excluded.name, place = excluded.place
         RETURNING id`,
        e.kind,
        e.key,
        e.name,
        entitySlug(e.key),
        e.scope,
        e.place,
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
    const r = this.db.get(`SELECT ${E} FROM entities e WHERE e.key = ?`, key);
    return r ? toEntity(r) : null;
  }

  bySlug(slug: string): Entity | null {
    if (!/^[0-9a-f]{24}$/.test(slug)) return null;
    const r = this.db.get(`SELECT ${E} FROM entities e WHERE e.slug = ?`, slug);
    return r ? toEntity(r) : null;
  }

  /**
   * The entities one run contributes, by key, with their slugs: what its page
   * may link to. Empty for a run that isn't (or couldn't be) indexed, so a
   * page never links to an entity its own run doesn't hold.
   */
  slugsOfRun(runId: string): Map<string, string> {
    const rows = this.db.all(
      `SELECT e.key, e.slug FROM entities e WHERE e.id IN (
         SELECT ce.entity_id FROM claim_entities ce JOIN claims c ON c.id = ce.claim_id
         WHERE c.run_id = ?1
         UNION SELECT subject_id FROM relations WHERE run_id = ?1
         UNION SELECT object_id FROM relations WHERE run_id = ?1)`,
      runId,
    );
    return new Map(rows.map((r) => [String(r.key), String(r.slug)]));
  }

  /**
   * Every place the graph holds entities in, one display name each (the
   * shortest way a run wrote it), alphabetical.
   */
  places(): { scope: string; place: string }[] {
    const best = new Map<string, string>();
    for (const r of this.db.all("SELECT DISTINCT scope, place FROM entities WHERE place != ''")) {
      const scope = String(r.scope), place = String(r.place), was = best.get(scope);
      if (
        was === undefined || place.length < was.length ||
        (place.length === was.length && place < was)
      ) {
        best.set(scope, place);
      }
    }
    return [...best].map(([scope, place]) => ({ scope, place }))
      .sort((a, b) => a.place.localeCompare(b.place));
  }

  /**
   * Entities in one place whose name contains the query (case, accents, and
   * punctuation aside), alphabetical by name. Never ordered by how much the
   * graph holds on each. An empty query lists the place.
   */
  search(scope: string, query: string): Entity[] {
    const q = nameKey(query);
    return this.db.all(`SELECT ${E} FROM entities e WHERE e.scope = ?`, scope)
      .map(toEntity)
      .filter((e) => nameKey(e.name).includes(q))
      .sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)) || a.key.localeCompare(b.key));
  }

  /** The entities each claim is about (role "subject"), by claim id. */
  subjectsOf(claimIds: readonly number[]): Map<number, Entity[]> {
    const out = new Map<number, Entity[]>();
    if (!claimIds.length) return out;
    const rows = this.db.all(
      `SELECT ce.claim_id, ${E} FROM claim_entities ce JOIN entities e ON e.id = ce.entity_id
       WHERE ce.role = 'subject' AND ce.claim_id IN (${claimIds.map(() => "?").join(", ")})
       ORDER BY e.name, e.id`,
      ...claimIds,
    );
    for (const r of rows) {
      const id = Number(r.claim_id);
      out.set(id, [...(out.get(id) ?? []), toEntity(r)]);
    }
    return out;
  }

  /**
   * Contributions the entity made or received, each with the filing's words
   * and the pages it was read from. Unordered here: the page sorts them by
   * name, never by amount.
   */
  contributionsOf(entityId: number): StoredContribution[] {
    const rows = this.db.all(
      `SELECT rel.id AS rel_id, rel.run_id, rel.detail, 'made' AS direction, ${E},
              s.url, rc.source_name, rc.author, rc.published
       FROM relations rel JOIN entities e ON e.id = rel.object_id
       JOIN relation_citations rc ON rc.relation_id = rel.id JOIN sources s ON s.id = rc.source_id
       WHERE rel.relation = 'contributed_to' AND rel.subject_id = ?1
       UNION ALL
       SELECT rel.id, rel.run_id, rel.detail, 'received', ${E},
              s.url, rc.source_name, rc.author, rc.published
       FROM relations rel JOIN entities e ON e.id = rel.subject_id
       JOIN relation_citations rc ON rc.relation_id = rel.id JOIN sources s ON s.id = rc.source_id
       WHERE rel.relation = 'contributed_to' AND rel.object_id = ?1
       ORDER BY rel_id, url`,
      entityId,
    );
    const out: StoredContribution[] = [];
    let last = -1;
    for (const r of rows) {
      if (Number(r.rel_id) !== last) {
        last = Number(r.rel_id);
        out.push({
          direction: r.direction as "made" | "received",
          other: toEntity(r),
          run_id: String(r.run_id),
          detail: JSON.parse(String(r.detail)) as ContributionDetail,
          citations: [],
        });
      }
      out.at(-1)!.citations.push(toCitation(r));
    }
    return out;
  }

  /** Every run that contributes anything about or to the entity, with how it appears there. */
  runsOf(entityId: number): Map<string, Set<string>> {
    const rows = this.db.all(
      `SELECT c.run_id, 'claim_' || ce.role || CASE WHEN c.verified = 1 THEN '' ELSE '_unverified' END AS how
       FROM claim_entities ce JOIN claims c ON c.id = ce.claim_id WHERE ce.entity_id = ?1
       UNION SELECT run_id, relation || '_out' FROM relations WHERE subject_id = ?1
       UNION SELECT run_id, relation || '_in' FROM relations WHERE object_id = ?1`,
      entityId,
    );
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      const id = String(r.run_id);
      out.set(id, (out.get(id) ?? new Set()).add(String(r.how)));
    }
    return out;
  }

  /**
   * The others a candidate or measure side can be compared with: every other
   * candidate (a person on a ballot) and every measure side in the same place.
   * Alphabetical. Null for any other entity: it isn't compared with anyone.
   */
  peersOf(e: Entity): Entity[] | null {
    if (!this.isComparable(e)) return null;
    return this.db.all(
      `SELECT ${E} FROM entities e WHERE e.scope = ?1 AND e.id != ?2 AND (e.kind = 'side'
         OR (e.kind = 'person' AND EXISTS (SELECT 1 FROM relations r
           WHERE r.subject_id = e.id AND r.relation = 'candidate_for')))`,
      e.scope,
      e.id,
    ).map(toEntity).sort((a, b) =>
      nameKey(a.name).localeCompare(nameKey(b.name)) || a.key.localeCompare(b.key)
    );
  }

  /** A measure side, or a person who was on a ballot. */
  isComparable(e: Entity): boolean {
    if (e.kind === "side") return true;
    return e.kind === "person" && this.db.get(
          "SELECT 1 AS x FROM relations WHERE subject_id = ? AND relation = 'candidate_for'",
          e.id,
        ) !== undefined;
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
      claim.citations.push(toCitation(r));
    }
    return out;
  }

  /** Every relation the entity takes part in, either side. */
  linksOf(entityId: number): Link[] {
    const rows = this.db.all(
      `SELECT rel.relation, rel.run_id, rel.detail, 'out' AS direction,
              ${E}
       FROM relations rel JOIN entities e ON e.id = rel.object_id WHERE rel.subject_id = ?1
       UNION ALL
       SELECT rel.relation, rel.run_id, rel.detail, 'in' AS direction,
              ${E}
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
  tiesOf(entityId: number): Ties {
    const out: Ties = new Map();
    // One row per tie and citation, in order; consecutive rows of one tie are grouped.
    let last: { id: string; tie: GraphTie } | null = null;
    const add = (id: string, r: Row, tie: () => GraphTie) => {
      if (last?.id !== id) {
        const e = toEntity(r);
        const got = out.get(e.id) ?? { entity: e, ties: [] };
        last = { id, tie: tie() };
        got.ties.push(last.tie);
        out.set(e.id, got);
      }
      last.tie.citations.push(toCitation(r));
    };
    for (
      const r of this.db.all(
        `SELECT rel.id AS tie_id, rel.run_id, rel.detail, ${E},
                s.url, rc.source_name, rc.author, rc.published
         FROM relations rel
         JOIN entities e ON e.id = rel.subject_id
         JOIN relation_citations rc ON rc.relation_id = rel.id
         JOIN sources s ON s.id = rc.source_id
         WHERE rel.relation = 'contributed_to' AND rel.object_id = ?
         ORDER BY rel.id, s.id`,
        entityId,
      )
    ) {
      add(`r${r.tie_id}`, r, () => ({
        kind: "contribution",
        run_id: String(r.run_id),
        detail: JSON.parse(String(r.detail)) as ContributionDetail,
        citations: [],
      }));
    }
    const sections = SUPPORT_SECTIONS.map((x) => `'${x}'`).join(", ");
    for (
      const r of this.db.all(
        `SELECT c.id AS claim_id, c.run_id, c.section, c.statement, ${E},
                s.url, ci.source_name, ci.author, ci.published
         FROM claim_entities about
         JOIN claims c ON c.id = about.claim_id
         JOIN claim_entities n ON n.claim_id = c.id AND n.role = 'named'
         JOIN entities e ON e.id = n.entity_id
         JOIN citations ci ON ci.claim_id = c.id
         JOIN sources s ON s.id = ci.source_id
         WHERE about.entity_id = ? AND about.role = 'subject' AND c.verified = 1
           AND c.section IN (${sections})
         ORDER BY c.id, e.id, s.id`,
        entityId,
      )
    ) {
      add(`c${r.claim_id}|${r.id}`, r, () => ({
        kind: "named",
        run_id: String(r.run_id),
        section: String(r.section),
        statement: String(r.statement),
        citations: [],
      }));
    }
    return out;
  }

  /**
   * The contributors and endorsers two entities share: every entity tied to
   * both (tiesOf), by entity identity only. Entity keys carry their scope, so
   * two subjects in one jurisdiction only ever share that jurisdiction's
   * entities; nothing is matched on name here.
   */
  sharedBetween(
    aId: number,
    bId: number,
    a: Ties = this.tiesOf(aId),
    b: Ties = this.tiesOf(bId),
  ): SharedConnection[] {
    return [...a.values()].flatMap((x) => {
      const y = b.get(x.entity.id);
      return y && x.entity.id !== aId && x.entity.id !== bId
        ? [{ entity: x.entity, a: x.ties, b: y.ties }]
        : [];
    }).sort((p, q) => p.entity.name.localeCompare(q.entity.name));
  }

  /**
   * Two entities in one place compared: what they share (sharedBetween) and
   * the near misses between everything each is tied to, flagged by the same
   * nearMisses the page view uses. Entities in different places share
   * nothing here, whatever their names. `aTies` lets a page comparing one
   * entity with many read its ties once.
   */
  between(a: Entity, b: Entity, aTies: Ties = this.tiesOf(a.id)): GraphPair {
    if (a.scope !== b.scope) return { shared: [], possible: [] };
    const bTies = this.tiesOf(b.id);
    // Keys carry their scope, so ties are already in a's place; the scope check is
    // defense in depth, since mixing places is the one thing this view must never do.
    const others = (m: Ties) =>
      [...m.values()].map((x) => x.entity)
        .filter((x) => x.id !== a.id && x.id !== b.id && x.scope === a.scope);
    return {
      shared: this.sharedBetween(a.id, b.id, aTies, bTies)
        .filter((x) => x.entity.scope === a.scope),
      possible: nearMisses(others(aTies), others(bTies)),
    };
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
