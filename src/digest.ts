/**
 * Section digests (roadmap item 15): "X, Y, and Z report A, B, and C" over a
 * section's one-line-per-fact list, with the facts kept right below.
 *
 * One tool-less call per run (Digester) writes the lines. Everything here
 * checks them, so a bad answer can at worst leave a summary out, never show
 * one that strays from the record:
 * - Only verified facts are sent, each with a short id. A line must cite at
 *   least one, and only facts of its own section (the brief: of its own
 *   candidate or measure).
 * - A line may not name an outlet none of its facts come from, another
 *   candidate none of its facts name, or use an evaluative word
 *   (CHARACTERIZATIONS) none of its facts use.
 * - Every candidate is summarized the same way: a section left out for one
 *   candidate is left out for all of them, and a measure's case for and case
 *   against stand or fall together. The page says why each is missing.
 * - A failed check is sent back once with what was wrong. The better of the
 *   two answers is kept.
 * - The input's hash is saved, so the same facts are never paid for twice.
 *
 * A quote found on a page (the quote check) says nothing about the digest's
 * wording: the page labels it a model's summary and the facts stay the record.
 */

import { createHash } from "node:crypto";
import { characterization, findNames } from "./context.ts";
import { nameKey } from "./knowledge.ts";
import { MEASURE_SECTIONS, priorityId, SECTIONS } from "./template.ts";
import type {
  Digester,
  DigestLine,
  DigestRequest,
  DigestResult,
  Fact,
  MeasureDossier,
  PriorityResult,
  RaceDossier,
  RawDigest,
  RawDigestLine,
  SectionResult,
  SubjectDigest,
} from "./types.ts";

/** Bumped when the request or the checks change, so saved digests are made again. */
export const DIGEST_VERSION = 1;
/** A section needs this many facts to be summarized; one fact is its own summary. */
export const MIN_SECTION_FACTS = 2;
/** A candidate or measure needs this many facts for a brief across its sections. */
export const MIN_BRIEF_FACTS = 4;
/** Most facts in one call. Over it, the run gets no digest and the page says why. */
export const MAX_DIGEST_FACTS = 400;
/** Statements are cut to this length in the request, marked "[cut]"; the page shows them whole. */
export const MAX_DIGEST_STATEMENT_CHARS = 500;
export const MAX_SECTION_LINES = 4;
export const MAX_BRIEF_LINES = 4;
export const MAX_LINE_CHARS = 360;

export const BRIEF = "brief";

interface Part {
  id: string;
  title: string;
  result: SectionResult | undefined;
}

interface Subject {
  name: string;
  /** Failed or unfinished: kept in place, so digests line up with candidates, but never sent. */
  skip: boolean;
  parts: Part[];
}

interface Slot {
  subject: number;
  section: string;
  index: number;
  fact: Fact;
}

/** One run's digest, ready to send and to check what comes back. */
export interface DigestPlan<T> {
  request: DigestRequest;
  hash: string;
  /** Facts sent. */
  sent: number;
  /** Checks an answer: each subject's kept lines and what was left out. */
  check(raw: RawDigest): SubjectDigest[];
  /** The dossier with this digest on it. */
  finish(subjects: SubjectDigest[] | null, error?: string): T;
}

const sourcesOf = (f: Fact) => [f.source_name, ...(f.also ?? []).map((a) => a.source_name)];

function priorityParts(p: readonly PriorityResult[] | undefined): Part[] {
  return (p ?? []).map((x, i) => ({ id: priorityId(i), title: x.issue, result: x.result }));
}

function raceSubjects(r: RaceDossier): Subject[] {
  return r.candidates.map((c) => ({
    name: c.candidate.name,
    skip: c.status !== "ok",
    parts: [
      ...priorityParts(c.priorities),
      ...SECTIONS.map((s) => ({ id: s.id, title: s.title, result: c.sections[s.id] })),
    ],
  }));
}

function measureSubjects(d: MeasureDossier): Subject[] {
  return [{
    name: d.query.label,
    skip: d.status !== "ok",
    parts: [
      ...priorityParts(d.priorities),
      ...MEASURE_SECTIONS.map((s) => ({ id: s.id, title: s.title, result: d.sections[s.id] })),
    ],
  }];
}

/** The input's identity: what is sent, the model, and the rules, never the answer. */
export function digestHash(request: DigestRequest, model: string): string {
  const { problems: _, ...sent } = request;
  return createHash("sha256").update(JSON.stringify({ v: DIGEST_VERSION, model, sent }))
    .digest("hex");
}

function cut(s: string): string {
  return s.length > MAX_DIGEST_STATEMENT_CHARS
    ? `${s.slice(0, MAX_DIGEST_STATEMENT_CHARS)} [cut]`
    : s;
}

/** A word or name in text, as whole words, any case or accent. */
function mentions(text: string, name: string): boolean {
  const k = nameKey(name);
  return k.length > 0 && ` ${nameKey(text)} `.includes(` ${k} `);
}

function surname(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w));
  return words[words.length - 1] ?? "";
}

function plan<T>(
  contest: string,
  subjects: Subject[],
  pairs: readonly (readonly string[])[],
  model: string,
  now: Date,
  apply: (digest: DigestResult) => T,
): DigestPlan<T> | null {
  const slots = new Map<string, Slot>();
  let n = 0;
  const request: DigestRequest = {
    contest,
    subjects: subjects.flatMap((s, si) => {
      if (s.skip) return [];
      const sections = s.parts.filter((p) => p.result?.facts.length).map((p) => ({
        id: p.id,
        title: p.title,
        summarize: p.result!.facts.length >= MIN_SECTION_FACTS,
        facts: p.result!.facts.map((f, index) => {
          const id = `f${++n}`;
          slots.set(id, { subject: si, section: p.id, index, fact: f });
          return {
            id,
            statement: cut(f.statement),
            sources: [...new Set(sourcesOf(f))],
            type: f.evidence_type,
          };
        }),
      }));
      const total = sections.reduce((a, x) => a + x.facts.length, 0);
      return [{ id: `s${si + 1}`, name: s.name, brief: total >= MIN_BRIEF_FACTS, sections }];
    }),
  };
  const asked = request.subjects.some((s) => s.brief || s.sections.some((x) => x.summarize));
  if (!asked) return null;
  const hash = digestHash(request, model);
  const result = (subjects: SubjectDigest[], error?: string): DigestResult => ({
    model,
    made_at: now.toISOString(),
    input_hash: hash,
    subjects,
    ...(error ? { error } : {}),
  });
  const empty = () => subjects.map(() => ({ brief: [], sections: {}, left_out: [] }));
  if (n > MAX_DIGEST_FACTS) {
    const error = `${n} facts is over the ${MAX_DIGEST_FACTS} one summary call takes`;
    return {
      request,
      hash,
      sent: 0,
      check: () => empty(),
      finish: () => apply(result(empty(), error)),
    };
  }
  const outlets = [...new Set([...slots.values()].flatMap((s) => sourcesOf(s.fact)))];
  return {
    request,
    hash,
    sent: n,
    check: (raw) => checkDigest(request, raw, slots, subjects, outlets, pairs),
    finish: (s, error) => apply(result(s ?? empty(), error)),
  };
}

/** Why a line can't stand, or null. */
function lineProblem(
  raw: RawDigestLine,
  allowed: ReadonlySet<string>,
  slots: ReadonlyMap<string, Slot>,
  outlets: readonly string[],
  others: readonly string[],
  subject: string,
): string | null {
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  if (!text) return "a line is empty";
  if (text.length > MAX_LINE_CHARS) return `a line is over ${MAX_LINE_CHARS} characters`;
  const ids = Array.isArray(raw.facts) ? raw.facts.filter((x) => typeof x === "string") : [];
  if (!ids.length) return `"${text.slice(0, 60)}" cites no fact`;
  const bad = ids.find((id) => !allowed.has(id));
  if (bad) return `"${text.slice(0, 60)}" cites ${bad}, which isn't one of its facts`;
  const cited = ids.map((id) => slots.get(id)!.fact);
  const sources = new Set(cited.flatMap(sourcesOf).map(nameKey));
  const words = cited.map((f) => f.statement).join(" ");
  const outlet = outlets.find((o) => mentions(text, o) && !sources.has(nameKey(o)));
  if (outlet) return `"${text.slice(0, 60)}" names ${outlet}, which none of its facts come from`;
  const other = others.find((o) => mentions(text, o) && !mentions(words, o));
  if (other) return `"${text.slice(0, 60)}" names ${other}, whom none of its facts name`;
  // Any other name, an outlet the run never cited included, must come from the cited facts:
  // each of its words in their statements or sources ("Hertzberg" for "Bob Hertzberg").
  const known = new Set(nameKey(`${words} ${[...sources].join(" ")} ${subject}`).split(" "));
  const stray = findNames(text).find((n) => nameKey(n).split(" ").some((w) => !known.has(w)));
  if (stray) return `"${text.slice(0, 60)}" names ${stray}, which none of its facts name`;
  const word = characterization(text);
  if (word && !mentions(words, word)) {
    return `"${text.slice(0, 60)}" says "${word}", which none of its facts say`;
  }
  return null;
}

function toLine(raw: RawDigestLine, slots: ReadonlyMap<string, Slot>): DigestLine {
  return {
    text: raw.text.trim(),
    facts: [...new Set(raw.facts)].map((id) => {
      const s = slots.get(id)!;
      return { section: s.section, index: s.index };
    }),
  };
}

function checkDigest(
  request: DigestRequest,
  raw: RawDigest,
  slots: ReadonlyMap<string, Slot>,
  subjects: readonly Subject[],
  outlets: readonly string[],
  pairs: readonly (readonly string[])[],
): SubjectDigest[] {
  const out: SubjectDigest[] = subjects.map(() => ({ brief: [], sections: {}, left_out: [] }));
  const answers = new Map(
    (Array.isArray(raw?.subjects) ? raw.subjects : []).map((s) => [s?.id, s]),
  );
  for (const rs of request.subjects) {
    const si = Number(rs.id.slice(1)) - 1;
    const answer = answers.get(rs.id);
    const others = subjects.filter((_, i) => i !== si).map((s) => surname(s.name)).filter(Boolean);
    const take = (section: string, lines: unknown, allowed: Set<string>, max: number) => {
      const list = (Array.isArray(lines) ? lines : []) as RawDigestLine[];
      if (!list.length) return out[si].left_out.push({ section, reason: "no summary was given" });
      if (list.length > max) {
        return out[si].left_out.push({ section, reason: `over ${max} lines` });
      }
      const problem = list.map((l) => lineProblem(l, allowed, slots, outlets, others, rs.name))
        .find(Boolean);
      if (problem) return out[si].left_out.push({ section, reason: problem });
      const kept = list.map((l) => toLine(l, slots));
      if (section === BRIEF) out[si].brief = kept;
      else out[si].sections[section] = kept;
    };
    if (rs.brief) {
      const all = new Set(rs.sections.flatMap((x) => x.facts.map((f) => f.id)));
      take(BRIEF, answer?.brief, all, MAX_BRIEF_LINES);
    }
    const given = new Map(
      (Array.isArray(answer?.sections) ? answer.sections : []).map((x) => [x?.id, x?.lines]),
    );
    for (const sec of rs.sections.filter((x) => x.summarize)) {
      take(sec.id, given.get(sec.id), new Set(sec.facts.map((f) => f.id)), MAX_SECTION_LINES);
    }
  }
  return even(out, pairs);
}

/**
 * The same template for everyone: a section or brief left out for one
 * candidate is left out for every candidate who had it, and a pair (a
 * measure's case for and against) stands or falls together.
 */
function even(out: SubjectDigest[], pairs: readonly (readonly string[])[]): SubjectDigest[] {
  const drop = (s: SubjectDigest, section: string, reason: string) => {
    if (section === BRIEF ? !s.brief.length : !s.sections[section]) return;
    if (section === BRIEF) s.brief = [];
    else delete s.sections[section];
    s.left_out.push({ section, reason });
  };
  const failed = new Set(out.flatMap((s) => s.left_out.map((l) => l.section)));
  if (out.length > 1) {
    for (const section of failed) {
      for (const s of out) {
        drop(s, section, "left out for every candidate, since another's didn't pass its checks");
      }
    }
  }
  for (const pair of pairs) {
    const miss = pair.find((p) => out.some((s) => s.left_out.some((l) => l.section === p)));
    if (!miss) continue;
    for (const s of out) {
      for (const p of pair) {
        if (p !== miss) drop(s, p, "left out with its other side, which didn't pass its checks");
      }
    }
  }
  return out;
}

/** How many sections and briefs a checked digest left out. */
export function leftOut(subjects: readonly SubjectDigest[]): number {
  return subjects.reduce((a, s) => a + s.left_out.length, 0);
}

/** What was wrong, said back to the model once. Never names whose section it was beyond its id. */
export function problemsOf(
  request: DigestRequest,
  subjects: readonly SubjectDigest[],
): string[] {
  return request.subjects.flatMap((rs) => {
    const s = subjects[Number(rs.id.slice(1)) - 1];
    return (s?.left_out ?? []).filter((l) => !l.reason.startsWith("left out "))
      .map((l) => `${rs.id} ${l.section}: ${l.reason}`);
  });
}

export function planRace(r: RaceDossier, model: string, now: Date): DigestPlan<RaceDossier> | null {
  const contest = `${r.query.office}, ${r.query.city}, ${r.query.state}, ${r.query.electionDate}`;
  return plan(contest, raceSubjects(r), [], model, now, (digest) => ({ ...r, digest }));
}

export function planMeasure(
  d: MeasureDossier,
  model: string,
  now: Date,
): DigestPlan<MeasureDossier> | null {
  const q = d.query;
  const contest = `${q.label}, ${q.jurisdiction}, ${q.state}, ${q.electionDate}`;
  return plan(
    contest,
    measureSubjects(d),
    [["case_for", "case_against"]],
    model,
    now,
    (digest) => ({ ...d, digest }),
  );
}

/** Whether a dossier already has a digest of exactly these facts. */
export function isCurrent(d: { digest?: DigestResult }, p: DigestPlan<unknown>): boolean {
  return d.digest?.input_hash === p.hash && !d.digest.error;
}

/**
 * Sends a plan, checks the answer, and sends it back once with what was
 * wrong if anything was left out. Keeps the answer that left out less.
 */
export async function runPlan<T>(
  p: DigestPlan<T>,
  digester: Digester,
): Promise<{ dossier: T; calls: number; left_out: number }> {
  if (!p.sent) return { dossier: p.finish(null, undefined), calls: 0, left_out: 0 };
  const first = p.check(await digester.digestFacts(p.request));
  const problems = problemsOf(p.request, first);
  if (!problems.length) return { dossier: p.finish(first), calls: 1, left_out: leftOut(first) };
  const second = p.check(await digester.digestFacts({ ...p.request, problems }));
  const best = leftOut(second) < leftOut(first) ? second : first;
  return { dossier: p.finish(best), calls: 2, left_out: leftOut(best) };
}

/** A whole run whose call failed: recorded, so the page can say why there's no summary. */
export function digestFailed<T>(p: DigestPlan<T>, error: string): T {
  return p.finish(null, error);
}
