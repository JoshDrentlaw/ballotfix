/**
 * The knowledge graph's shape, and how a finished dossier maps onto it.
 *
 * A dossier is a page: facts grouped by section under one candidate or
 * measure. The graph holds the same facts as claims about entities (people,
 * offices, measures), each claim with its citations, plus typed relations
 * between entities ("candidate_for"). That is what lets later steps merge one
 * fact reported by several outlets into one claim, and connect candidates and
 * measures through shared donors, endorsers, and cases. Merged facts (one
 * fact, several outlets; src/merge.ts) become one claim with several citations.
 *
 * Nothing here touches storage; src/web/kb.ts writes a Projection to SQLite.
 * The graph is derived from saved runs and can always be rebuilt from them,
 * so bumping KNOWLEDGE_VERSION after changing this file reindexes everything.
 *
 * Context notes (src/context.ts) add the people and organizations the facts
 * name: each verified note is a claim about its entity, and every claim whose
 * statement names it links to it with the role "named", so later steps can
 * connect candidates through shared donors and endorsers.
 *
 * Campaign finance (src/finance.ts) adds who gave to whom: each verified
 * contribution is a "contributed_to" relation from the contributor to the
 * candidate (or to a measure's side), with the filing's own words as detail
 * and the page it was read from as the relation's citation. A contributor
 * joins an existing entity only by the rule named entities use: kind, state,
 * jurisdiction, and normalized name. An individual also needs the same
 * stated occupation and employer (contributorRef); otherwise they are kept
 * apart, since same-named people are common.
 *
 * Invariants carried over: a claim keeps its provenance (source, author,
 * date, URL) per citation, and an unverified fact stays unverified.
 */

import { attachNotes } from "./context.ts";
import { normalizeUrl } from "./dossier.ts";
import { MEASURE_SECTION_IDS, priorityId, SECTION_IDS } from "./template.ts";
import type {
  ContextNote,
  ContextResult,
  Contribution,
  EvidenceType,
  Fact,
  FinanceResult,
  MeasureDossier,
  MeasureQuery,
  PriorityResult,
  RaceDossier,
  SectionResult,
} from "./types.ts";

/** Bump when projection logic changes; the app rebuilds the graph from saved runs on start. */
export const KNOWLEDGE_VERSION = 5;

/** "side": the supporters or the opponents of one measure, so the two can be compared. */
export const ENTITY_KINDS = ["person", "office", "measure", "organization", "side"] as const;
export type EntityKind = typeof ENTITY_KINDS[number];

/**
 * candidate_for: the person is on the ballot for the office (detail: election
 * date, and "retention" for a yes/no retention question).
 * holds: the person was listed as the office's incumbent for that election.
 * contributed_to: a contribution on a filing, from the contributor to a
 * candidate or a measure's side (detail: ContributionDetail as JSON; cited).
 * side_of: the side is one of the measure's two (detail: "support" or "oppose").
 */
export const RELATIONS = ["candidate_for", "holds", "contributed_to", "side_of"] as const;
export type Relation = typeof RELATIONS[number];

/** Section name for facts whose URL the session never retrieved. */
export const UNVERIFIED_SECTION = "unverified";
/** Section name for a context note: a claim about a named person or organization. */
export const CONTEXT_SECTION = "context";
/**
 * Sections whose named entities count as support when comparing two
 * subjects: a candidate's endorsements, and each side's case for a measure.
 */
export const SUPPORT_SECTIONS = ["endorsements", "case_for", "case_against"] as const;

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
  /** Entity keys of the people and organizations the statement names (role "named"). */
  named: string[];
  /** Other entities the claim is also about (role "subject"): a measure's side for its case. */
  also_about?: string[];
}

export interface RelationDraft {
  subject: string;
  relation: Relation;
  object: string;
  detail: string | null;
  /** Where the relation was read, for relations that come from a record (contributed_to). */
  citations?: Citation[];
}

/** A contributed_to relation's detail: the filing's own words, plus the row's place in the run. */
export interface ContributionDetail {
  filer: string;
  amount: string;
  date: string | null;
  filing_period: string | null;
  filing: string | null;
  /** Keeps two identical rows (same amount, same day) two relations. */
  row: number;
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

/**
 * A jurisdiction as part of an identity: "City of Fontana" (how a ballot
 * names who placed a measure) and "Fontana" (how a race names its city) are
 * one place, as are "County of X" and "X County". "County of San Bernardino"
 * stays apart from the city of San Bernardino.
 */
export function jurisdictionKey(j: string): string {
  const k = nameKey(j).replace(/^(the )?(city (and )?county|city|town|village) of /, "");
  // "County of San Bernardino" is how a ballot names it; "San Bernardino County" a race.
  const county = k.match(/^county of (.+)$/);
  return county ? `${county[1]} county` : k;
}

function ref(kind: EntityKind, name: string, scope: string[]): EntityRef {
  const [state, jurisdiction, ...rest] = scope.map(nameKey);
  const parts = [state, jurisdictionKey(jurisdiction ?? ""), ...rest, nameKey(name)];
  return { kind, name, key: `${kind}:${parts.join("|")}` };
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

/** Scoped like a person: a same-named organization elsewhere is a different entity. */
export function organizationRef(state: string, jurisdiction: string, name: string): EntityRef {
  return ref("organization", name, [state, jurisdiction]);
}

export function officeRef(state: string, jurisdiction: string, office: string): EntityRef {
  return ref("office", office, [state, jurisdiction]);
}

/** Measure letters are reused across jurisdictions and years, so both are part of the identity. */
export function measureRef(m: MeasureQuery): EntityRef {
  return ref("measure", m.label, [m.state, m.jurisdiction, m.electionDate]);
}

/** The supporters or the opponents of one measure. */
export function sideRef(m: MeasureQuery, side: "support" | "oppose"): EntityRef {
  const measure = measureRef(m);
  return {
    kind: "side",
    name: `${side === "support" ? "Supporters" : "Opponents"} of ${m.label}`,
    key: `side:${measure.key.slice("measure:".length)}|${side}`,
  };
}

/** The entity a verified context note describes: the rule every named entity follows. */
export function noteRef(n: ContextNote, state: string, jurisdiction: string): EntityRef {
  return n.kind === "person"
    ? personRef(state, jurisdiction, n.name)
    : organizationRef(state, jurisdiction, n.name);
}

/**
 * What a filing says about an individual's work when it says nothing that
 * tells two same-named people apart: blanks, placeholders for a missing
 * answer ("Information requested per best efforts"), and statuses many
 * people share. Matched on the whole normalized field.
 */
const NOT_IDENTIFYING = new RegExp(
  "^(?:" + [
    "",
    "n ?a",
    "none",
    "not applicable",
    "not employed",
    "unemployed",
    "retired",
    "self",
    "self employed",
    "self employed owner",
    "owner",
    "business owner",
    "homemaker",
    "student",
    "unknown",
    "refused",
    "declined",
    "pending",
    "(?:information |info )?requested.*",
    ".*best efforts?.*",
  ].join("|") + ")$",
);

/**
 * The entity a contribution's contributor is, or null when the record doesn't
 * say whether it is an individual or an organization: then it is never matched.
 *
 * An organization follows the named-entity rule exactly: "Smith Development"
 * and "Smith Development LLC" are two entities (the page says they may be
 * one). An individual needs the rule plus the same stated occupation and
 * employer, both identifying; otherwise the row is its own entity, keyed by
 * `row`, so two same-named people are never merged on name alone.
 */
export function contributorRef(
  state: string,
  jurisdiction: string,
  c: Pick<Contribution, "contributor" | "contributor_type" | "occupation" | "employer">,
  row: string,
): EntityRef | null {
  if (c.contributor_type === "organization") {
    return organizationRef(state, jurisdiction, c.contributor);
  }
  if (c.contributor_type !== "individual") return null;
  const person = personRef(state, jurisdiction, c.contributor);
  const work = [c.occupation ?? "", c.employer ?? ""].map(nameKey);
  const identifies = work.every((w) => !NOT_IDENTIFYING.test(w));
  return {
    ...person,
    key: `${person.key}|donor ${identifies ? work.join("|") : `row ${row}`}`,
  };
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

/**
 * Facts without a usable URL are left out: a claim never exists without
 * provenance. A merged fact (src/merge.ts) is one claim citing every source
 * folded into it.
 */
/** Which named entities a statement mentions, by the same rule the page attaches notes. */
type Namer = (statement: string) => string[];

function claimsFrom(
  subject: string,
  section: string,
  facts: readonly Fact[],
  verified: boolean,
  named: Namer,
  issue: string | null = null,
): ClaimDraft[] {
  const out: ClaimDraft[] = [];
  facts.forEach((f, position) => {
    const c = citationOf(f);
    if (!c) return;
    const also = (f.also ?? []).map(citationOf).filter((x): x is Citation => x !== null);
    out.push({
      subject,
      section,
      issue,
      position,
      statement: f.statement,
      evidence_type: f.evidence_type,
      verified,
      citations: [c, ...also],
      named: named(f.statement),
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
  named: Namer,
): ClaimDraft[] {
  return [
    // Runs saved before a section existed simply lack it.
    ...sectionIds.flatMap((id) => claimsFrom(subject, id, sections[id]?.facts ?? [], true, named)),
    ...(priorities ?? []).flatMap((p, i) =>
      claimsFrom(subject, priorityId(i), p.result.facts, true, named, p.issue)
    ),
    ...claimsFrom(subject, UNVERIFIED_SECTION, unverified, false, named),
  ];
}

/**
 * The entities a run's verified context notes name, each with its note as a
 * claim about it, and the rule for finding them in a statement. Unverified
 * notes add nothing: their kind and identity rest on an unretrieved page.
 */
function namedEntities(
  context: ContextResult | undefined,
  state: string,
  jurisdiction: string,
): { entities: EntityRef[]; claims: ClaimDraft[]; named: Namer } {
  const notes = (context?.notes ?? []).filter((n) => n.verified);
  const keys = new Map(notes.map((n) => [n, noteRef(n, state, jurisdiction)]));
  const claims = notes.flatMap((n, position): ClaimDraft[] => {
    const c = citationOf({ ...n, statement: n.note, evidence_type: "reported" });
    if (!c) return [];
    return [{
      subject: keys.get(n)!.key,
      section: CONTEXT_SECTION,
      issue: null,
      position,
      statement: n.note,
      // Who someone is, from a page about them: closest to a report, and never a primary record.
      evidence_type: "reported",
      verified: true,
      citations: [c],
      named: [],
    }];
  });
  const named: Namer = (statement) => [
    ...new Set(
      attachNotes(statement, notes).flatMap((p) =>
        typeof p === "string" ? [] : [keys.get(p.note)!.key]
      ),
    ),
  ];
  return { entities: [...keys.values()], claims, named };
}

/** Entities listed once each, first occurrence wins. */
function uniqueEntities(refs: EntityRef[]): EntityRef[] {
  const seen = new Map<string, EntityRef>();
  for (const r of refs) if (!seen.has(r.key)) seen.set(r.key, r);
  return [...seen.values()];
}

/**
 * A run's verified contributions as contributed_to relations, each citing the
 * page it was read from. `recipient` finds the entity a subject's money went
 * to. Unverified rows, and rows whose contributor type the record doesn't
 * state, add nothing: a relation never exists without a retrieved source.
 */
function financeRelations(
  finance: FinanceResult | undefined,
  state: string,
  jurisdiction: string,
  recipient: (s: FinanceResult["subjects"][number]) => EntityRef | null,
  runId: string,
): { entities: EntityRef[]; relations: RelationDraft[] } {
  const entities: EntityRef[] = [];
  const relations: RelationDraft[] = [];
  let row = 0;
  (finance?.subjects ?? []).forEach((s, i) => {
    const to = recipient(s);
    s.contributions.forEach((c, n) => {
      row++;
      if (!to || !c.verified) return;
      const url_key = normalizeUrl(c.source_url);
      const cite: Citation | null = url_key === null ? null : {
        url: c.source_url,
        url_key,
        source_name: c.source_name,
        author: null,
        published: null,
      };
      const from = contributorRef(state, jurisdiction, c, `${runId}|${i}|${n}`);
      if (!cite || !from) return;
      const detail: ContributionDetail = {
        filer: c.filer,
        amount: c.amount,
        date: c.date,
        filing_period: c.filing_period,
        filing: c.filing,
        row,
      };
      entities.push(from);
      relations.push({
        subject: from.key,
        relation: "contributed_to",
        object: to.key,
        detail: JSON.stringify(detail),
        citations: [cite],
      });
    });
  });
  return { entities, relations };
}

/** `runId` scopes a person whose dossier flagged a name ambiguity; see personRef. */
export function projectRace(race: RaceDossier, runId: string): Projection {
  const q = race.query;
  const office = officeRef(q.state, q.city, q.office);
  const detail = race.listing.contest_kind === "retention"
    ? `${q.electionDate} (retention)`
    : q.electionDate;
  const ctx = namedEntities(race.context, q.state, q.city);
  const entities: EntityRef[] = [office, ...ctx.entities];
  const claims: ClaimDraft[] = [...ctx.claims];
  const relations: RelationDraft[] = [];
  const people = new Map<number, EntityRef>();
  for (const [i, c] of race.candidates.entries()) {
    if (c.status === "pending") continue;
    const person = personRef(
      q.state,
      q.city,
      c.candidate.name,
      c.identity_note ? runId : undefined,
    );
    people.set(i, person);
    entities.push(person);
    relations.push({ subject: person.key, relation: "candidate_for", object: office.key, detail });
    if (c.candidate.incumbent) {
      relations.push({ subject: person.key, relation: "holds", object: office.key, detail });
    }
    claims.push(
      ...subjectClaims(
        person.key,
        SECTION_IDS,
        c.sections,
        c.priorities,
        c.unverified,
        ctx.named,
      ),
    );
  }
  const money = financeRelations(
    race.finance,
    q.state,
    q.city,
    (s) => s.candidate === undefined ? null : people.get(s.candidate) ?? null,
    runId,
  );
  return {
    entities: uniqueEntities([...entities, ...money.entities]),
    claims,
    relations: [...relations, ...money.relations],
  };
}

/** `runId` keeps contributors who can't be told apart to this run; see contributorRef. */
export function projectMeasure(m: MeasureDossier, runId: string): Projection {
  if (m.status === "pending") return { entities: [], claims: [], relations: [] };
  const measure = measureRef(m.query);
  if (m.official_title) measure.name = `${m.query.label}: ${m.official_title}`;
  const sides = { support: sideRef(m.query, "support"), oppose: sideRef(m.query, "oppose") };
  const ctx = namedEntities(m.context, m.query.state, m.query.jurisdiction);
  // Each side's case is also about that side, so the graph can compare the two.
  const sideOf: Partial<Record<string, string>> = {
    case_for: sides.support.key,
    case_against: sides.oppose.key,
  };
  const claims = subjectClaims(
    measure.key,
    MEASURE_SECTION_IDS,
    m.sections,
    m.priorities,
    m.unverified,
    ctx.named,
  ).map((c) => {
    const side = c.verified ? sideOf[c.section] : undefined;
    return side ? { ...c, also_about: [side] } : c;
  });
  const money = financeRelations(
    m.finance,
    m.query.state,
    m.query.jurisdiction,
    (s) => s.side ? sides[s.side] : null,
    runId,
  );
  return {
    entities: uniqueEntities([
      measure,
      sides.support,
      sides.oppose,
      ...ctx.entities,
      ...money.entities,
    ]),
    claims: [...ctx.claims, ...claims],
    relations: [
      { subject: sides.support.key, relation: "side_of", object: measure.key, detail: "support" },
      { subject: sides.oppose.key, relation: "side_of", object: measure.key, detail: "oppose" },
      ...money.relations,
    ],
  };
}
