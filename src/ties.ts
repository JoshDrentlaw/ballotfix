/**
 * Tie roles (roadmap item 16): what a named tie's fact says the name does.
 *
 * A name in an Endorsements or case for/against fact may support the
 * candidate or measure, oppose it (Trellis lists groups recommending No), or
 * only be the outlet that reported it. Item 12 stopped calling them all
 * endorsers; this marks each one where the fact's own words say which.
 *
 * One tool-less call per run (TieRoleMarker) proposes a role and the words
 * that say it. A mark stands only if:
 * - its role is supports, opposes, or reported (anything else is no mark);
 * - its words are found, whole-word and in order, in that fact's statement,
 *   and are more than the name itself.
 * Every other tie stays "named", as before. The page shows the words with
 * the mark, so the reader can see what it rests on. Nothing is counted up.
 * The same call and the same rule cover every candidate and both sides.
 */

import { createHash } from "node:crypto";
import { attachNotes } from "./context.ts";
import { plainText } from "./dossier.ts";
import { nameKey } from "./knowledge.ts";
import type {
  ContextResult,
  Fact,
  MeasureDossier,
  RaceDossier,
  RawTieRole,
  TieRoleMark,
  TieRoleMarker,
  TieRoleRequest,
  TieRoleResult,
} from "./types.ts";
import { TIE_ROLES } from "./types.ts";

/** Bumped when the request or the checks change, so saved marks are made again. */
export const TIES_VERSION = 1;
/** Most ties in one call; over it, the run's ties stay unmarked and the log says so. */
export const MAX_TIES = 200;
export const MAX_TIE_WORDS_CHARS = 160;
/** Statements are cut to this length in the request; the words must still be in the whole one. */
export const MAX_TIE_STATEMENT_CHARS = 600;

/** One named tie as the pages build it: a support fact and a name with a verified note in it. */
export interface NamedTie {
  section: string;
  subject: number;
  index: number;
  name: string;
  fact: Fact;
}

/** The key a page looks a mark up by. */
export function tieKey(t: { section: string; subject: number; index: number; name: string }) {
  return `${t.section}|${t.subject}|${t.index}|${nameKey(t.name)}`;
}

function tiesIn(
  section: string,
  subject: number,
  facts: readonly Fact[] | undefined,
  context: ContextResult | undefined,
): NamedTie[] {
  const notes = (context?.notes ?? []).filter((n) => n.verified);
  return (facts ?? []).flatMap((fact, index) =>
    attachNotes(fact.statement, notes).flatMap((p) =>
      typeof p === "string" ? [] : [{ section, subject, index, name: p.note.name, fact }]
    )
  );
}

/** The named ties raceParties builds, in ballot order. */
export function raceTies(r: RaceDossier): NamedTie[] {
  return r.candidates.flatMap((c, i) =>
    c.status === "ok" ? tiesIn("endorsements", i, c.sections.endorsements?.facts, r.context) : []
  );
}

/** The named ties measureParties builds: the case for, then the case against. */
export function measureTies(m: MeasureDossier): NamedTie[] {
  if (m.status !== "ok") return [];
  return [
    ...tiesIn("case_for", 0, m.sections.case_for?.facts, m.context),
    ...tiesIn("case_against", 0, m.sections.case_against?.facts, m.context),
  ];
}

export interface TiePlan<T> {
  request: TieRoleRequest;
  hash: string;
  check(raw: readonly RawTieRole[]): TieRoleMark[];
  finish(marks: TieRoleMark[] | null, error?: string): T;
}

export function tieHash(request: TieRoleRequest, model: string): string {
  return createHash("sha256").update(JSON.stringify({ v: TIES_VERSION, model, request }))
    .digest("hex");
}

function plan<T>(
  contest: string,
  ties: NamedTie[],
  subjectOf: (t: NamedTie) => string,
  model: string,
  now: Date,
  apply: (r: TieRoleResult) => T,
): TiePlan<T> | null {
  if (!ties.length || ties.length > MAX_TIES) return null;
  const byId = new Map(ties.map((t, i) => [`t${i + 1}`, t]));
  const request: TieRoleRequest = {
    contest,
    ties: [...byId].map(([id, t]) => ({
      id,
      name: t.name,
      subject: subjectOf(t),
      statement: t.fact.statement.length > MAX_TIE_STATEMENT_CHARS
        ? `${t.fact.statement.slice(0, MAX_TIE_STATEMENT_CHARS)} [cut]`
        : t.fact.statement,
    })),
  };
  const hash = tieHash(request, model);
  return {
    request,
    hash,
    check: (raw) => checkMarks(raw, byId),
    finish: (marks, error) =>
      apply({
        model,
        made_at: now.toISOString(),
        input_hash: hash,
        marks: marks ?? [],
        ...(error ? { error } : {}),
      }),
  };
}

/** Keeps a mark only where its role is one of TIE_ROLES and its words are in the fact. */
export function checkMarks(
  raw: readonly RawTieRole[],
  byId: ReadonlyMap<string, NamedTie>,
): TieRoleMark[] {
  const seen = new Set<string>();
  const out: TieRoleMark[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const t = typeof r?.id === "string" ? byId.get(r.id) : undefined;
    if (!t || seen.has(r.id)) continue;
    const role = (TIE_ROLES as readonly string[]).includes(r.role)
      ? r.role as TieRoleMark["role"]
      : null;
    const words = typeof r.words === "string" ? r.words.trim() : "";
    if (!role || !words || words.length > MAX_TIE_WORDS_CHARS) continue;
    const said = plainText(words);
    if (!said.trim() || !plainText(t.fact.statement).includes(said)) continue;
    // The name alone says nothing about what it does.
    if (nameKey(words) === nameKey(t.name)) continue;
    seen.add(r.id);
    out.push({ section: t.section, subject: t.subject, index: t.index, name: t.name, role, words });
  }
  return out;
}

export function planRaceTies(
  r: RaceDossier,
  model: string,
  now: Date,
): TiePlan<RaceDossier> | null {
  const q = r.query;
  return plan(
    `${q.office}, ${q.city}, ${q.state}, ${q.electionDate}`,
    raceTies(r),
    (t) => `the candidate ${r.candidates[t.subject].candidate.name}`,
    model,
    now,
    (tie_roles) => ({ ...r, tie_roles }),
  );
}

export function planMeasureTies(
  m: MeasureDossier,
  model: string,
  now: Date,
): TiePlan<MeasureDossier> | null {
  const q = m.query;
  return plan(
    `${q.label}, ${q.jurisdiction}, ${q.state}, ${q.electionDate}`,
    measureTies(m),
    () => `the measure ${q.label} (supporting it means backing a yes vote)`,
    model,
    now,
    (tie_roles) => ({ ...m, tie_roles }),
  );
}

export function tiesCurrent(d: { tie_roles?: TieRoleResult }, p: TiePlan<unknown>): boolean {
  return d.tie_roles?.input_hash === p.hash && !d.tie_roles.error;
}

export async function runTies<T>(
  p: TiePlan<T>,
  marker: TieRoleMarker,
): Promise<{ dossier: T; marked: number }> {
  const marks = p.check(await marker.markTieRoles(p.request));
  return { dossier: p.finish(marks), marked: marks.length };
}

/** The marks of a dossier by tieKey, for the pages. */
export function marksOf(d: { tie_roles?: TieRoleResult } | undefined): Map<string, TieRoleMark> {
  return new Map((d?.tie_roles?.marks ?? []).map((m) => [tieKey(m), m]));
}
