/**
 * The knowledge graph's shape, and how a finished dossier maps onto it.
 *
 * A dossier is a page: facts grouped by section under one candidate or
 * measure. The graph holds the same facts as claims about entities (people,
 * offices, measures), each claim with its citations, plus typed relations
 * between entities ("candidate_for"). That is what lets later steps merge one
 * fact reported by several outlets into one claim, and connect candidates and
 * measures through shared donors, endorsers, and cases.
 *
 * Nothing here touches storage; src/web/kb.ts writes a Projection to SQLite.
 * The graph is derived from saved runs and can always be rebuilt from them,
 * so bumping KNOWLEDGE_VERSION after changing this file reindexes everything.
 *
 * Invariants carried over: a claim keeps its provenance (source, author,
 * date, URL) per citation, and an unverified fact stays unverified.
 */

import { normalizeUrl } from "./dossier.ts";
import { MEASURE_SECTION_IDS, priorityId, SECTION_IDS } from "./template.ts";
import type {
  EvidenceType,
  Fact,
  MeasureDossier,
  MeasureQuery,
  PriorityResult,
  RaceDossier,
  SectionResult,
} from "./types.ts";

/** Bump when projection logic changes; the app rebuilds the graph from saved runs on start. */
export const KNOWLEDGE_VERSION = 2;

export const ENTITY_KINDS = ["person", "office", "measure"] as const;
export type EntityKind = typeof ENTITY_KINDS[number];

/**
 * candidate_for: the person is on the ballot for the office (detail: election
 * date, and "retention" for a yes/no retention question).
 * holds: the person was listed as the office's incumbent for that election.
 */
export const RELATIONS = ["candidate_for", "holds"] as const;
export type Relation = typeof RELATIONS[number];

/** Section name for facts whose URL the session never retrieved. */
export const UNVERIFIED_SECTION = "unverified";

export interface EntityRef {
  kind: EntityKind;
  /** Stable identity: kind plus normalized name and scope. Equal keys are one entity. */
  key: string;
  /** Display name as first seen. */
  name: string;
}

export interface Citation {
  url: string;
  /** normalizeUrl(url): one source row per page, however the URL was written. */
  url_key: string;
  source_name: string;
  author: string | null;
  published: string | null;
}

export interface ClaimDraft {
  /** Entity key the claim is about. */
  subject: string;
  /** Template section id, priority_n, or UNVERIFIED_SECTION. */
  section: string;
  /** For priority_n: the voter's issue in their words, since n means a different issue per run. */
  issue: string | null;
  /** Order within its section, as the dossier shows it. */
  position: number;
  statement: string;
  evidence_type: EvidenceType;
  verified: boolean;
  citations: Citation[];
}

export interface RelationDraft {
  subject: string;
  relation: Relation;
  object: string;
  detail: string | null;
}

export interface Projection {
  entities: EntityRef[];
  claims: ClaimDraft[];
  relations: RelationDraft[];
}

/** Case, accents, punctuation, and spacing don't make a different name. */
export function nameKey(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function ref(kind: EntityKind, name: string, scope: string[]): EntityRef {
  return { kind, name, key: `${kind}:${[...scope, name].map(nameKey).join("|")}` };
}

/**
 * A person is scoped to the state and jurisdiction they ran in. Two people
 * with the same name are common enough that merging across jurisdictions on
 * name alone would attribute one person's record to another; matching across
 * them needs evidence, and is left to a later step.
 *
 * Within a jurisdiction, the same name is taken as the same person unless the
 * research flagged a name ambiguity (a non-empty identity_note); then the
 * person is kept to this one run (`ambiguousIn`). Two same-named people who
 * ran there without either run noticing are still merged: a known limit.
 */
export function personRef(
  state: string,
  jurisdiction: string,
  name: string,
  ambiguousIn?: string,
): EntityRef {
  const r = ref("person", name, [state, jurisdiction]);
  return ambiguousIn ? { ...r, key: `${r.key}|run ${ambiguousIn}` } : r;
}

export function officeRef(state: string, jurisdiction: string, office: string): EntityRef {
  return ref("office", office, [state, jurisdiction]);
}

/** Measure letters are reused across jurisdictions and years, so both are part of the identity. */
export function measureRef(m: MeasureQuery): EntityRef {
  return ref("measure", m.label, [m.state, m.jurisdiction, m.electionDate]);
}

function citationOf(f: Fact): Citation | null {
  const url_key = normalizeUrl(f.source_url);
  if (url_key === null) return null;
  return {
    url: f.source_url,
    url_key,
    source_name: f.source_name,
    author: f.author,
    published: f.published,
  };
}

/** Facts without a usable URL are left out: a claim never exists without provenance. */
function claimsFrom(
  subject: string,
  section: string,
  facts: readonly Fact[],
  verified: boolean,
  issue: string | null = null,
): ClaimDraft[] {
  const out: ClaimDraft[] = [];
  facts.forEach((f, position) => {
    const c = citationOf(f);
    if (!c) return;
    out.push({
      subject,
      section,
      issue,
      position,
      statement: f.statement,
      evidence_type: f.evidence_type,
      verified,
      citations: [c],
    });
  });
  return out;
}

function subjectClaims(
  subject: string,
  sectionIds: readonly string[],
  sections: Partial<Record<string, SectionResult>>,
  priorities: readonly PriorityResult[] | undefined,
  unverified: readonly Fact[],
): ClaimDraft[] {
  return [
    // Runs saved before a section existed simply lack it.
    ...sectionIds.flatMap((id) => claimsFrom(subject, id, sections[id]?.facts ?? [], true)),
    ...(priorities ?? []).flatMap((p, i) =>
      claimsFrom(subject, priorityId(i), p.result.facts, true, p.issue)
    ),
    ...claimsFrom(subject, UNVERIFIED_SECTION, unverified, false),
  ];
}

/** Entities listed once each, first occurrence wins. */
function uniqueEntities(refs: EntityRef[]): EntityRef[] {
  const seen = new Map<string, EntityRef>();
  for (const r of refs) if (!seen.has(r.key)) seen.set(r.key, r);
  return [...seen.values()];
}

/** `runId` scopes a person whose dossier flagged a name ambiguity; see personRef. */
export function projectRace(race: RaceDossier, runId: string): Projection {
  const q = race.query;
  const office = officeRef(q.state, q.city, q.office);
  const detail = race.listing.contest_kind === "retention"
    ? `${q.electionDate} (retention)`
    : q.electionDate;
  const entities: EntityRef[] = [office];
  const claims: ClaimDraft[] = [];
  const relations: RelationDraft[] = [];
  for (const c of race.candidates) {
    if (c.status === "pending") continue;
    const person = personRef(
      q.state,
      q.city,
      c.candidate.name,
      c.identity_note ? runId : undefined,
    );
    entities.push(person);
    relations.push({ subject: person.key, relation: "candidate_for", object: office.key, detail });
    if (c.candidate.incumbent) {
      relations.push({ subject: person.key, relation: "holds", object: office.key, detail });
    }
    claims.push(
      ...subjectClaims(person.key, SECTION_IDS, c.sections, c.priorities, c.unverified),
    );
  }
  return { entities: uniqueEntities(entities), claims, relations };
}

export function projectMeasure(m: MeasureDossier): Projection {
  if (m.status === "pending") return { entities: [], claims: [], relations: [] };
  const measure = measureRef(m.query);
  if (m.official_title) measure.name = `${m.query.label}: ${m.official_title}`;
  return {
    entities: [measure],
    claims: subjectClaims(
      measure.key,
      MEASURE_SECTION_IDS,
      m.sections,
      m.priorities,
      m.unverified,
    ),
    relations: [],
  };
}
