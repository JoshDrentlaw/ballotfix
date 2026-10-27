/**
 * Campaign finance: itemized contributions read off the filings (California
 * Form 460 and 497 on a city's or county's portal, Cal-Access for state
 * committees), and the people and organizations two candidates, or the two
 * sides of a measure, share through money or support.
 *
 * One capped model call per run (FinanceResearcher), after the context step.
 * Everything that comes back is checked here:
 * - A contribution is shown as fact only if its URL is a page the call
 *   actually retrieved. Others are kept apart as unverified, never matched.
 * - Filer, contributor, amount, date, and filing period stay as the record
 *   states them. A field too long to be a record's is dropped with its row,
 *   never cut; a row missing a filer, contributor, or amount is dropped too,
 *   and the page counts what was dropped.
 * - Every subject (each candidate, or each side of a measure) gets the same
 *   share of the cap and the same instruction. Rows over the share are
 *   listed on the page, not kept. A subject with nothing found gets a gap
 *   note, never silence, and so does every subject when the call fails.
 * - Nothing is summed, ranked, or characterized: totals are the filing's own
 *   lines, and the page lists contributors alphabetically.
 *
 * Shared connections match by entity identity only (src/knowledge.ts): the
 * same kind, state, jurisdiction, and normalized name, and for an individual
 * the same identifying occupation and employer. Near misses ("Smith
 * Development" and "Smith Development LLC") stay separate, and the page says
 * they may be one.
 */

import { attachNotes } from "./context.ts";
import { normalizeUrl } from "./dossier.ts";
import {
  contributorRef,
  type EntityRef,
  nameKey,
  nearMisses,
  noteRef,
  type PossibleMatch,
  type SUPPORT_SECTIONS,
} from "./knowledge.ts";
import {
  type Contribution,
  CONTRIBUTOR_TYPES,
  type ContributorType,
  type Fact,
  type FinanceRequest,
  type FinanceResearcher,
  type FinanceResult,
  type FinanceSubject,
  type FinanceSubjectResult,
  type FinanceTotal,
  type MeasureDossier,
  PORTAL_PROBLEMS,
  type PortalGap,
  type PortalProblem,
  type RaceDossier,
  type RawContribution,
  type RawFinanceResult,
  type RawFinanceSubject,
  type SectionResult,
} from "./types.ts";

/** Most contributions kept in one run, shared equally. Bounds the answer's size and cost. */
export const MAX_FINANCE_CONTRIBUTIONS = 120;
/** Most kept for any one candidate or side, however few there are. */
export const MAX_CONTRIBUTIONS_PER_SUBJECT = 20;
/** Summary-page totals kept per candidate or side. */
export const MAX_TOTALS_PER_SUBJECT = 4;
/** Longer than any field a filing has: a row with one is dropped, never cut. */
export const MAX_FIELD_CHARS = 200;
/** The model's own explanations (gap notes, portal problems) are cut here, marked; not dropped. */
export const MAX_NOTE_CHARS = 600;
/** Committees, searches, and portal gaps listed, at most. */
const MAX_LIST = 10;

/** The same share for every subject: what the cap allows each, never more than the per-subject cap. */
export function shareFor(subjects: number): number {
  return subjects
    ? Math.min(MAX_CONTRIBUTIONS_PER_SUBJECT, Math.floor(MAX_FINANCE_CONTRIBUTIONS / subjects))
    : 0;
}

// ---------------------------------------------------------------------------
// Who is looked up
// ---------------------------------------------------------------------------

interface Plan {
  request: FinanceRequest;
  /** Per subject id, the result's label, and its side or candidate index. */
  labels: { subject: string; side?: "support" | "oppose"; candidate?: number }[];
}

/**
 * Every candidate on the ballot, in ballot order, including one whose
 * research failed: the filings don't depend on the dossier.
 */
function racePlan(race: RaceDossier): Plan {
  const q = race.query;
  const listed = race.candidates.flatMap((c, candidate) =>
    c.status === "pending" ? [] : [{ subject: c.candidate.name, candidate }]
  );
  const subjects: FinanceSubject[] = listed.map((l, i) => ({
    id: `s${i + 1}`,
    name: l.subject,
    role: "candidate",
  }));
  return {
    request: {
      place: `${q.city}, ${q.state}`,
      contest: race.listing.contest_kind === "retention" ? `${q.office} (retention)` : q.office,
      electionDate: q.electionDate,
      subjects,
      perSubject: shareFor(subjects.length),
    },
    labels: listed,
  };
}

/** The committees for and against a measure: two subjects, the same share. */
function measurePlan(m: MeasureDossier): Plan {
  const q = m.query;
  const label = q.label;
  return {
    request: {
      place: [q.jurisdiction, q.state].filter(Boolean).join(", "),
      contest: q.question ? `${label}: ${q.question}` : label,
      electionDate: q.electionDate,
      subjects: [
        { id: "s1", name: label, role: "support" },
        { id: "s2", name: label, role: "oppose" },
      ],
      perSubject: shareFor(2),
    },
    labels: [{ subject: label, side: "support" }, { subject: label, side: "oppose" }],
  };
}

// ---------------------------------------------------------------------------
// Checking what comes back
// ---------------------------------------------------------------------------

const TOO_LONG = Symbol("too long");

/** Trimmed, as stated; TOO_LONG for a field no record has, so its row is dropped whole. */
function field(v: unknown): string | typeof TOO_LONG {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > MAX_FIELD_CHARS ? TOO_LONG : s;
}

/** An explanation, not a record's field: kept, and cut with a mark when long. */
function note(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > MAX_NOTE_CHARS ? `${s.slice(0, MAX_NOTE_CHARS)}…` : s;
}

function list(v: unknown): string[] {
  return (Array.isArray(v) ? v : [])
    .map(field)
    .filter((s): s is string => typeof s === "string" && s !== "")
    .slice(0, MAX_LIST);
}

/** A contribution as stated, or null when it can't be shown as a record's row. */
function toContribution(raw: RawContribution, retrieved: ReadonlySet<string>): Contribution | null {
  const f = {
    filer: field(raw.filer),
    contributor: field(raw.contributor),
    occupation: field(raw.occupation),
    employer: field(raw.employer),
    amount: field(raw.amount),
    date: field(raw.date),
    filing_period: field(raw.filing_period),
    filing: field(raw.filing),
    source_name: field(raw.source_name),
    source_url: field(raw.source_url),
  };
  if (Object.values(f).some((v) => v === TOO_LONG)) return null;
  const s = f as Record<keyof typeof f, string>;
  const url = normalizeUrl(s.source_url);
  if (!s.filer || !s.contributor || !/\d/.test(s.amount) || url === null) return null;
  const type = field(raw.contributor_type);
  return {
    filer: s.filer,
    contributor: s.contributor,
    contributor_type: (CONTRIBUTOR_TYPES as readonly unknown[]).includes(type)
      ? type as ContributorType
      : "unknown",
    occupation: s.occupation || null,
    employer: s.employer || null,
    amount: s.amount,
    date: s.date || null,
    filing_period: s.filing_period || null,
    filing: s.filing || null,
    source_name: s.source_name || "source name not given",
    source_url: s.source_url,
    verified: retrieved.has(url),
  };
}

/** Only totals on a retrieved page are kept: a total is a figure, and needs a record. */
function toTotal(raw: RawFinanceSubject["totals"][number], retrieved: ReadonlySet<string>) {
  const f = [raw.filer, raw.label, raw.amount, raw.filing_period, raw.source_name, raw.source_url]
    .map(field);
  if (f.some((v) => v === TOO_LONG)) return null;
  const [filer, label, amount, filing_period, source_name, source_url] = f as string[];
  const url = normalizeUrl(source_url);
  if (!filer || !label || !/\d/.test(amount) || url === null || !retrieved.has(url)) return null;
  return {
    filer,
    label,
    amount,
    filing_period: filing_period || null,
    source_name: source_name || "source name not given",
    source_url,
  } satisfies FinanceTotal;
}

/**
 * A row repeated in the answer, every field and the page alike, counts once
 * (and is counted as dropped). Two same-looking rows from different pages,
 * or differing in any field, are both kept: they may be two contributions.
 */
function rowKey(c: Contribution): string {
  return JSON.stringify([
    c.filer,
    c.contributor,
    c.contributor_type,
    c.occupation,
    c.employer,
    c.amount,
    c.date,
    c.filing_period,
    c.filing,
    normalizeUrl(c.source_url),
  ]);
}

export const NOTHING_FOUND =
  "No contributions on a filing this run retrieved were found. That is not evidence there are none.";

function checkSubject(
  label: Plan["labels"][number],
  raw: Partial<RawFinanceSubject> | undefined,
  retrieved: ReadonlySet<string>,
  share: number,
): FinanceSubjectResult {
  const verified: Contribution[] = [], unverified: Contribution[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const r of Array.isArray(raw?.contributions) ? raw.contributions : []) {
    const c = toContribution(r ?? {}, retrieved);
    if (!c) {
      dropped++;
      continue;
    }
    const k = rowKey(c);
    if (seen.has(k)) {
      dropped++;
      continue;
    }
    seen.add(k);
    (c.verified ? verified : unverified).push(c);
  }
  const totals: FinanceTotal[] = [];
  for (const r of Array.isArray(raw?.totals) ? raw.totals : []) {
    const t = toTotal(r ?? {}, retrieved);
    if (t && totals.length < MAX_TOTALS_PER_SUBJECT) totals.push(t);
    else dropped++;
  }
  // The answer is asked for largest first, so the share keeps the same kind of row for everyone.
  const kept = verified.slice(0, share);
  dropped += Math.max(0, unverified.length - share);
  const gap = note(raw?.gap_note);
  const notListed = note(raw?.not_listed);
  return {
    subject: label.subject,
    ...(label.side ? { side: label.side } : {}),
    ...(label.candidate !== undefined ? { candidate: label.candidate } : {}),
    committees: list(raw?.committees),
    totals,
    contributions: kept,
    unverified: unverified.slice(0, share),
    left_out: verified.slice(share).map((c) => `${c.contributor}, ${c.amount}`),
    not_listed: notListed || null,
    dropped,
    searched: list(raw?.searched),
    gap_note: gap || (kept.length ? null : NOTHING_FOUND),
  };
}

function checkPortalGaps(raw: unknown): PortalGap[] {
  return (Array.isArray(raw) ? raw : []).flatMap((g): PortalGap[] => {
    const o = (g ?? {}) as Record<string, unknown>;
    // Only the name has to be short; a gap with a long explanation is still a gap.
    const portal = note(o.portal).slice(0, MAX_FIELD_CHARS), url = field(o.url);
    const problem = field(o.problem);
    if (!portal) return [];
    return [{
      portal,
      url: typeof url === "string" && normalizeUrl(url) !== null ? url : null,
      problem: (PORTAL_PROBLEMS as readonly unknown[]).includes(problem)
        ? problem as PortalProblem
        : "other",
      note: note(o.note),
    }];
  }).slice(0, MAX_LIST);
}

/** One result per subject asked about, in the request's order, whatever the answer held. */
export function checkFinance(
  plan: Pick<Plan, "labels"> & { request: Pick<FinanceRequest, "subjects" | "perSubject"> },
  raw: RawFinanceResult,
): FinanceResult {
  const retrieved = new Set(
    raw.retrieved_urls.map(normalizeUrl).filter((u): u is string => u !== null),
  );
  const byId = new Map<string, RawFinanceSubject>();
  for (const s of Array.isArray(raw.subjects) ? raw.subjects : []) {
    if (s && typeof s.id === "string" && !byId.has(s.id)) byId.set(s.id, s);
  }
  return {
    subjects: plan.request.subjects.map((s, i) =>
      checkSubject(plan.labels[i], byId.get(s.id), retrieved, plan.request.perSubject)
    ),
    per_subject: plan.request.perSubject,
    portal_gaps: checkPortalGaps(raw.portal_gaps),
    model: raw.model,
  };
}

// ---------------------------------------------------------------------------
// Running the step
// ---------------------------------------------------------------------------

export interface FinanceStepResult<T> {
  dossier: T;
  /** Subjects asked about; 0 means no call was made. */
  sent: number;
  /** Verified contributions kept, all subjects. */
  shown: number;
  /** Verified contributions over the share, listed but not kept. */
  left_out: number;
}

async function lookUp<T extends { finance?: FinanceResult }>(
  d: T,
  plan: Plan,
  researcher: FinanceResearcher,
): Promise<FinanceStepResult<T>> {
  if (!plan.request.subjects.length) return { dossier: d, sent: 0, shown: 0, left_out: 0 };
  const finance = checkFinance(plan, await researcher.findContributions(plan.request));
  return {
    dossier: { ...d, finance },
    sent: plan.request.subjects.length,
    shown: finance.subjects.reduce((n, s) => n + s.contributions.length, 0),
    left_out: finance.subjects.reduce((n, s) => n + s.left_out.length, 0),
  };
}

/** One call for the whole race; every candidate gets the same instruction and share. */
export function financeForRace(
  race: RaceDossier,
  researcher: FinanceResearcher,
): Promise<FinanceStepResult<RaceDossier>> {
  return lookUp(race, racePlan(race), researcher);
}

export function financeForMeasure(
  m: MeasureDossier,
  researcher: FinanceResearcher,
): Promise<FinanceStepResult<MeasureDossier>> {
  return lookUp(m, measurePlan(m), researcher);
}

/** The dossier after a failed call: every subject gets a gap note saying so. */
function failed<T extends { finance?: FinanceResult }>(d: T, plan: Plan, error: string): T {
  if (!plan.request.subjects.length) return d;
  const gap = "Campaign finance filings couldn't be looked up in this run.";
  return {
    ...d,
    finance: {
      subjects: plan.labels.map((l) => checkSubject(l, { gap_note: gap }, new Set(), 0)),
      per_subject: plan.request.perSubject,
      portal_gaps: [],
      model: null,
      error,
    },
  };
}

export const raceFinanceFailed = (race: RaceDossier, error: string) =>
  failed(race, racePlan(race), error);
export const measureFinanceFailed = (m: MeasureDossier, error: string) =>
  failed(m, measurePlan(m), error);

// ---------------------------------------------------------------------------
// Shared connections
// ---------------------------------------------------------------------------

/** How an entity is tied to one party: it gave money, or a support fact names it. */
export type Tie =
  | { kind: "contribution"; contribution: Contribution }
  | { kind: "named"; section: typeof SUPPORT_SECTIONS[number]; fact: Fact };

/** One side of a comparison: a candidate, or a measure's supporters or opponents. */
export interface Party {
  label: string;
  ties: Map<string, { ref: EntityRef; ties: Tie[] }>;
  /** Contributors the record gives no type for: shown, never matched. */
  untyped: string[];
}

export interface Shared {
  ref: EntityRef;
  a: Tie[];
  b: Tie[];
}

export type { PossibleMatch };

export interface PairConnections {
  a: string;
  b: string;
  shared: Shared[];
  possible: PossibleMatch[];
}

function party(
  label: string,
  money: FinanceSubjectResult | undefined,
  // The graph (KnowledgeBase.tiesOf) reads support from the same sections, matches by the
  // same entity keys, and flags near misses with the same nearMisses. It works across runs;
  // this page view works from one dossier, so a downloaded page needs no database.
  support: readonly {
    section: typeof SUPPORT_SECTIONS[number];
    result: SectionResult | undefined;
  }[],
  scope: { state: string; jurisdiction: string; notes: RaceDossier["context"] },
  /** Row ids as the graph writes them (`run|subject|row`), so keys match the graph's. */
  row: { run: string; subject: number },
): Party {
  const ties = new Map<string, { ref: EntityRef; ties: Tie[] }>();
  const add = (ref: EntityRef, tie: Tie) => {
    const got = ties.get(ref.key) ?? { ref, ties: [] };
    got.ties.push(tie);
    ties.set(ref.key, got);
  };
  const untyped: string[] = [];
  (money?.contributions ?? []).forEach((c, n) => {
    if (!c.verified) return;
    const ref = contributorRef(
      scope.state,
      scope.jurisdiction,
      c,
      `${row.run}|${row.subject}|${n}`,
    );
    if (ref) add(ref, { kind: "contribution", contribution: c });
    else untyped.push(c.contributor);
  });
  // The same rule the graph's "named" role uses: verified notes, attached where the page shows them.
  const notes = (scope.notes?.notes ?? []).filter((n) => n.verified);
  for (const { section, result } of support) {
    for (const fact of result?.facts ?? []) {
      for (const p of attachNotes(fact.statement, notes)) {
        if (typeof p === "string") continue;
        add(noteRef(p.note, scope.state, scope.jurisdiction), { kind: "named", section, fact });
      }
    }
  }
  return { label, ties, untyped: [...new Set(untyped)] };
}

/** What two parties share by identity, and the near misses kept apart. */
export function compare(a: Party, b: Party): PairConnections {
  const shared: Shared[] = [];
  for (const [key, x] of a.ties) {
    const y = b.ties.get(key);
    if (y) shared.push({ ref: x.ref, a: x.ties, b: y.ties });
  }
  shared.sort((p, q) => nameKey(p.ref.name).localeCompare(nameKey(q.ref.name)));
  // An untyped contributor is never one entity with anything, even a same-named one.
  const entries = (p: Party, side: string) => [
    ...[...p.ties].map(([key, x]) => ({ key, name: x.ref.name })),
    ...p.untyped.map((name) => ({ key: `untyped:${side}:${name}`, name })),
  ];
  const possible = nearMisses(entries(a, "a"), entries(b, "b"));
  return { a: a.label, b: b.label, shared, possible };
}

/** Every pair, in ballot order: A–B, A–C, B–C. */
function pairs(parties: readonly Party[]): PairConnections[] {
  return parties.flatMap((a, i) => parties.slice(i + 1).map((b) => compare(a, b)));
}

/**
 * `runId`, when the app serves the page, makes each contributor's key the
 * graph's (see contributorRef), so an entry can link to its entity page.
 */
export function raceConnections(race: RaceDossier, runId = "page"): PairConnections[] {
  const q = race.query;
  const scope = { state: q.state, jurisdiction: q.city, notes: race.context };
  const subjects = race.finance?.subjects ?? [];
  return pairs(race.candidates.flatMap((c, i) => {
    if (c.status === "pending") return [];
    const subject = subjects.findIndex((s) => s.candidate === i);
    return [party(
      c.candidate.name,
      subjects[subject],
      c.status === "ok" ? [{ section: "endorsements", result: c.sections.endorsements }] : [],
      scope,
      { run: runId, subject },
    )];
  }));
}

export const SIDE_LABEL = { support: "Supporters", oppose: "Opponents" } as const;

/** The supporters against the opponents: each side's committees and its own case. */
export function measureConnections(m: MeasureDossier, runId = "page"): PairConnections[] {
  if (m.status !== "ok") return [];
  const q = m.query;
  const scope = { state: q.state, jurisdiction: q.jurisdiction, notes: m.context };
  const subjects = m.finance?.subjects ?? [];
  const side = (s: "support" | "oppose", section: "case_for" | "case_against") => {
    const subject = subjects.findIndex((x) => x.side === s);
    return party(
      SIDE_LABEL[s],
      subjects[subject],
      [{ section, result: m.sections[section] }],
      scope,
      { run: runId, subject },
    );
  };
  return pairs([side("support", "case_for"), side("oppose", "case_against")]);
}
