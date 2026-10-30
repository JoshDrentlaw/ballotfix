/**
 * Office powers: what the office a race fills can actually decide, its
 * budget, its seats, and its term, so a voter reading "not enough on record
 * to say" on an issue can tell whether the office has any say in it at all.
 *
 * - One capped lookup per office (OfficeResearcher.findOfficePowers), keyed by
 *   state + jurisdiction + office with any district or seat number left out
 *   (`officeKey`): a race reuses a verified lookup another finished run in the
 *   same place made within OFFICE_REUSE_DAYS, and the page says when.
 * - Its facts get the same provenance and quote check as a dossier's
 *   (`assembleSections`): only a page the lookup retrieved is shown as fact,
 *   and the name check looks for the place.
 * - Each of the voter's issues is marked inside, partly, or outside the
 *   office's say by a call without web tools that sees only the verified
 *   facts. A mark stands only on a verified, sourced fact it cites; anything
 *   else is "unclear". Issues worded as an earlier lookup's were keep its marks.
 * - The result sits on the race, once, the same for every candidate. It is
 *   never a stance and never combined with one.
 */

import { assembleSections, emptySections } from "./dossier.ts";
import { nameKey, scopeKey } from "./knowledge.ts";
import { OFFICE_SECTION_IDS, OFFICE_SECTIONS } from "./template.ts";
import {
  type Fact,
  ISSUE_SCOPES,
  type IssueScope,
  type IssueScopeValue,
  type OfficeFactRef,
  type OfficeResearcher,
  type OfficeResult,
  type OfficeSectionId,
  type RaceDossier,
  type RawIssueScope,
} from "./types.ts";

/** A lookup older than this is looked up again rather than reused: budgets change yearly. */
export const OFFICE_REUSE_DAYS = 365;

/** Longest basis kept for a mark; a longer one is replaced, never cut. */
export const MAX_BASIS_CHARS = 300;

/**
 * Words that name a seat, not an office: "District 2", "Seat A", "Office No. 12",
 * "Trustee Area 4". Only before a number, one letter, or a roman numeral, so
 * "District Attorney" stays as it is.
 */
const SEAT =
  /\b(?:district|seat|ward|division|(?:trustee )?area|office(?: no)?|no|department|dept|position|post)\s+(?:\d+[a-z]?|[a-z]|[ivx]+)\b/g;

/** The office as a cache key: the place, then the office without its seat or district. */
export function officeKey(state: string, jurisdiction: string, office: string): string {
  const o = nameKey(office).replace(SEAT, " ").replace(/\s+/g, " ").trim();
  return `${scopeKey(state, jurisdiction)}|${o}`;
}

/** A finished run's office lookup, as the step can reuse it. */
export interface KnownOffice {
  result: OfficeResult;
  /** The run whose lookup retrieved the pages, and when. */
  from: { run: string; looked_up: string };
}

/**
 * Whether a run's office result can be reused: the lookup didn't fail, it
 * found at least one verified fact, and it isn't older than OFFICE_REUSE_DAYS.
 */
export function reusable(
  result: OfficeResult | undefined,
  run: { id: string; updated_at: string },
  now: Date,
): KnownOffice | null {
  if (!result || result.error) return null;
  if (!OFFICE_SECTION_IDS.some((id) => result.sections[id]?.facts.length)) return null;
  const from = result.reused_from ?? { run: run.id, looked_up: run.updated_at };
  const age = now.getTime() - Date.parse(from.looked_up);
  if (!(age <= OFFICE_REUSE_DAYS * 86_400_000)) return null;
  return { result, from };
}

// ---------------------------------------------------------------------------
// Marking the voter's issues
// ---------------------------------------------------------------------------

/** The office's verified facts as the scope call sees them, ids f1..fn in section order. */
function factList(
  sections: OfficeResult["sections"],
): { id: string; ref: OfficeFactRef; f: Fact }[] {
  return OFFICE_SECTION_IDS.flatMap((section) =>
    (sections[section]?.facts ?? []).map((f, index) => ({ ref: { section, index }, f }))
  ).map((x, i) => ({ id: `f${i + 1}`, ...x }));
}

export const NO_POWERS_FOUND =
  "No verified source on this office's powers was found, so this can't be placed.";
export const NOT_SETTLED = "The verified sources on this office's powers don't settle this.";

const unclear = (issue: string, basis: string): IssueScope => ({
  issue,
  scope: "unclear",
  basis,
  rests_on: [],
});

/**
 * Checks the marks that came back: one per issue, in the voter's order. A
 * mark other than "unclear" stands only when it cites at least one verified
 * fact that isn't unsourced; otherwise it is "unclear", whatever the model said.
 */
export function checkScopes(
  issues: readonly string[],
  sections: OfficeResult["sections"],
  raw: readonly RawIssueScope[],
): IssueScope[] {
  const facts = new Map(factList(sections).map((x) => [x.id, x]));
  const answers = new Map<string, RawIssueScope>();
  for (const r of raw) if (!answers.has(r.id)) answers.set(r.id, r);
  return issues.map((issue, i) => {
    const a = answers.get(`i${i + 1}`);
    const scope = (ISSUE_SCOPES as readonly string[]).includes(a?.scope ?? "")
      ? a!.scope as IssueScopeValue
      : "unclear";
    const basis = typeof a?.basis === "string" ? a.basis.trim() : "";
    const shownBasis = basis && basis.length <= MAX_BASIS_CHARS ? basis : null;
    if (scope === "unclear") return unclear(issue, shownBasis ?? NOT_SETTLED);
    const cited = [...new Set(a!.fact_ids ?? [])].map((id) => facts.get(id))
      .filter((x) => x && x.f.evidence_type !== "unsourced");
    if (!cited.length) return unclear(issue, NOT_SETTLED);
    return { issue, scope, basis: shownBasis, rests_on: cited.map((x) => x!.ref) };
  });
}

/** The fact a mark cites, or null for a ref the sections no longer hold. */
export function factAt(sections: OfficeResult["sections"], ref: OfficeFactRef): Fact | null {
  return sections[ref.section]?.facts[ref.index] ?? null;
}

/**
 * Marks for the race's issues: from `earlier` where the same words were
 * marked against the same facts, else one call for the rest. No call when
 * there are no issues, and every issue is unclear when no fact was verified.
 */
async function markIssues(
  issues: readonly string[],
  office: OfficeResult,
  place: string,
  researcher: OfficeResearcher,
  earlier: readonly IssueScope[] = [],
): Promise<{ issues: IssueScope[]; asked: number }> {
  const facts = factList(office.sections);
  if (!issues.length) return { issues: [], asked: 0 };
  if (!facts.length) return { issues: issues.map((x) => unclear(x, NO_POWERS_FOUND)), asked: 0 };
  const known = new Map(earlier.map((x) => [nameKey(x.issue), x]));
  const ask = issues.filter((x) => !known.has(nameKey(x)));
  let fresh = new Map<string, IssueScope>();
  if (ask.length) {
    const raw = await researcher.markIssueScopes({
      place,
      office: office.office,
      facts: facts.map((x) => ({ id: x.id, statement: x.f.statement })),
      issues: ask.map((issue, i) => ({ id: `i${i + 1}`, issue })),
    });
    const checked = checkScopes(ask, office.sections, raw);
    fresh = new Map(checked.map((x) => [nameKey(x.issue), x]));
  }
  return {
    issues: issues.map((issue) => {
      const k = nameKey(issue);
      const m = fresh.get(k) ?? known.get(k)!;
      return { ...m, issue };
    }),
    asked: ask.length,
  };
}

// ---------------------------------------------------------------------------
// Running the step
// ---------------------------------------------------------------------------

export interface OfficeStepResult {
  dossier: RaceDossier;
  /** True when the powers were looked up in this run, false when reused. */
  looked_up: boolean;
  /** Verified facts on the office. */
  shown: number;
  /** Issues sent to be marked; 0 means no marking call was made. */
  marked: number;
}

const placeOf = (race: RaceDossier) => `${race.query.city}, ${race.query.state}`;

/**
 * The office step for one race: reuse `known` when given (an earlier run's
 * lookup of the same office in the same place, from `reusable`), else one
 * capped lookup; then mark the race's issues. A failed marking call keeps
 * the powers and records why, with every issue unclear.
 */
export async function officeForRace(
  race: RaceDossier,
  researcher: OfficeResearcher,
  known: KnownOffice | null = null,
): Promise<OfficeStepResult> {
  const q = race.query;
  let office: OfficeResult;
  if (known) {
    const { result } = known;
    office = {
      office: result.office,
      sections: result.sections,
      unverified: result.unverified,
      gaps: result.gaps,
      issues: [],
      model: result.model,
      reused_from: known.from,
    };
  } else {
    const raw = await researcher.findOfficePowers({
      place: placeOf(race),
      office: q.office,
      electionDate: q.electionDate,
    });
    const { sections, unverified } = assembleSections(
      OFFICE_SECTION_IDS,
      raw.sections,
      raw.retrieved_urls,
      raw.opened_pages,
      { shown: q.city, terms: q.city.trim() ? [q.city] : [] },
    );
    office = {
      office: q.office,
      sections,
      unverified,
      gaps: (raw.gaps ?? []).map((g) => g.trim()).filter(Boolean),
      issues: [],
      model: raw.model,
      ...(raw.effort ? { effort: raw.effort } : {}),
    };
  }
  const issues = race.priorities ?? [];
  let marked = 0;
  try {
    // An earlier run's marks are reused only where its own marking call worked.
    const earlier = known && !known.result.scope_error ? known.result.issues : [];
    const m = await markIssues(issues, office, placeOf(race), researcher, earlier);
    office.issues = m.issues;
    marked = m.asked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    office.scope_error = msg;
    office.issues = issues.map((x) => unclear(x, "Marking this issue failed in this run."));
  }
  return {
    dossier: { ...race, office },
    looked_up: !known,
    shown: OFFICE_SECTION_IDS.reduce((n, id) => n + office.sections[id].facts.length, 0),
    marked,
  };
}

/** The race after a failed lookup: every section says so and every issue is unclear. */
export function raceOfficeFailed(race: RaceDossier, error: string): RaceDossier {
  const note = "Looking up this office's powers failed in this run; nothing was checked.";
  return {
    ...race,
    office: {
      office: race.query.office,
      sections: emptySections(OFFICE_SECTION_IDS, note),
      unverified: [],
      gaps: [],
      issues: (race.priorities ?? []).map((x) => unclear(x, NO_POWERS_FOUND)),
      model: null,
      error,
    },
  };
}

/** Section titles, for the page. */
export const OFFICE_TITLE: Record<OfficeSectionId, string> = Object.fromEntries(
  OFFICE_SECTIONS.map((s) => [s.id, s.title]),
) as Record<OfficeSectionId, string>;
