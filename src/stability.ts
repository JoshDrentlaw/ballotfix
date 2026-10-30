/**
 * Stability run: how much one race's research changes from run to run.
 * Research is a sample, not a census: the same prompt can search, open, and
 * keep different pages each time. This reruns one race N times and reports,
 * per candidate and section, how much the verified URLs and facts overlap.
 *
 *   deno task stability --city Fontana --office Mayor [--candidates "A;B"] [--runs 3]
 *       prints an estimate and stops; add --yes to spend it
 *   deno task stability --compare a.json b.json [...]
 *       compares saved runs (CLI output or the app's /races/:id.json), no calls
 *
 * Only the research step reruns: the merge, context, and finance steps don't
 * change which pages a run kept. The candidate list is found once (or given)
 * and reused, so every run researches the same people in the same order.
 * The report compares research with research; it says nothing about any
 * candidate, and nothing in it is shown to voters.
 */

import { parseArgs } from "@std/cli/parse-args";
import { AnthropicResearcher, DEFAULT_MODEL, estimateCost } from "./research/anthropic.ts";
import { normalizeUrl, parsePriorities, plainText } from "./dossier.ts";
import { runRace } from "./race.ts";
import { slug } from "./render.ts";
import { SECTIONS } from "./template.ts";
import type { CandidateDossier, CandidateSource, Fact, RaceDossier, RaceQuery } from "./types.ts";
import { parseCandidates } from "./main.ts";

/** One section of one dossier, as the stability and answer-key reports compare it. */
export interface SectionFacts {
  /** A template section's id, or "issue:<the voter's words>" for a voter's issue. */
  key: string;
  title: string;
  /** Verified facts only: unverified ones were never shown as findings. */
  facts: Fact[];
}

/** A race from a CLI output file (a RaceDossier) or the app's run record (`race` inside). */
export function raceOf(json: unknown): RaceDossier {
  const o = json as { race?: RaceDossier | null; candidates?: unknown };
  if (Array.isArray(o?.candidates)) return o as RaceDossier;
  if (o?.race && Array.isArray(o.race.candidates)) return o.race;
  throw new Error("not a race: expected a dossier or a run record with a race in it");
}

/** A dossier's template sections in order, then the voter's issues, each by its words. */
export function sectionsOf(d: CandidateDossier): SectionFacts[] {
  return [
    ...SECTIONS.map((s) => ({
      key: s.id as string,
      title: s.title as string,
      facts: d.sections[s.id]?.facts ?? [],
    })),
    ...(d.priorities ?? []).map((p) => ({
      key: `issue:${p.issue}`,
      title: `Your issue: ${p.issue}`,
      facts: p.result.facts,
    })),
  ];
}

/** Every page a fact cites, merged sources included, normalized as the provenance check does. */
export function urlsOf(f: Fact): string[] {
  return [f, ...(f.also ?? [])].map((x) => normalizeUrl(x.source_url) ?? x.source_url);
}

/** Words that carry a statement: digits always, other words of three letters or more. */
function words(s: string): Set<string> {
  return new Set(plainText(s).trim().split(" ").filter((w) => w.length > 2 || /\d/.test(w)));
}

/**
 * How alike two statements' words are (Dice: twice the shared words over
 * both counts), 0 to 1. Two runs rarely word a fact the same way, so facts
 * are compared by words, not by text.
 */
export function similarity(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/**
 * Two statements this alike count as one fact. A heuristic: it misses a fact
 * reworded a lot and can join two close ones, so the JSON report lists the
 * statements for a person to check.
 */
export const SAME_FACT = 0.6;

/** Pairs of facts, one from each list, matched best first, each fact at most once. */
export function matchFacts(a: readonly Fact[], b: readonly Fact[]): [number, number][] {
  const pairs: { i: number; j: number; s: number }[] = [];
  a.forEach((fa, i) =>
    b.forEach((fb, j) => {
      const s = similarity(fa.statement, fb.statement);
      if (s >= SAME_FACT) pairs.push({ i, j, s });
    })
  );
  pairs.sort((p, q) => q.s - p.s || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>(), usedB = new Set<number>();
  const out: [number, number][] = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    out.push([p.i, p.j]);
  }
  return out;
}

/** Shared over all (Jaccard), 0 to 1; null when both are empty, which is agreement, not overlap. */
function overlap(shared: number, a: number, b: number): number | null {
  const all = a + b - shared;
  return all ? shared / all : null;
}

export interface Overlap {
  /** Mean over every pair of runs where either found something; null when no pair did. */
  mean: number | null;
  /** The lowest pair. */
  min: number | null;
}

function summarize(values: (number | null)[]): Overlap {
  const v = values.filter((x): x is number => x !== null);
  return v.length
    ? { mean: v.reduce((s, x) => s + x, 0) / v.length, min: Math.min(...v) }
    : { mean: null, min: null };
}

export interface SectionStability {
  key: string;
  title: string;
  /** Verified facts per run, in run order. */
  facts: number[];
  /** Runs that found something here: below every run, the page's "Found" cell changes between runs. */
  found_in: number;
  urls: Overlap & { union: number; in_every: number };
  /** Facts matched by wording (SAME_FACT), pair by pair. */
  fact_overlap: Overlap;
}

export interface CandidateStability {
  name: string;
  /** Runs that researched this candidate and didn't fail; the overlap is over these only. */
  compared: number;
  /** Runs where the candidate's research failed, or the candidate wasn't in the race. */
  missing: number;
  sections: SectionStability[];
  /** Every section's pages together: a page kept in another section still counts as kept. */
  urls: Overlap & { union: number; in_every: number };
  fact_overlap: Overlap;
}

export interface StabilityReport {
  query: RaceQuery;
  runs: number;
  generated_at: string[];
  candidates: CandidateStability[];
  /** Sections, over every candidate, found in some runs and not others. */
  flips: { candidate: string; section: string; found_in: number }[];
}

function urlOverlap(sets: Set<string>[]): Overlap & { union: number; in_every: number } {
  const pairs: (number | null)[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const shared = [...sets[i]].filter((u) => sets[j].has(u)).length;
      pairs.push(overlap(shared, sets[i].size, sets[j].size));
    }
  }
  const union = new Set(sets.flatMap((s) => [...s]));
  const inEvery = [...union].filter((u) => sets.every((s) => s.has(u))).length;
  return { ...summarize(pairs), union: union.size, in_every: inEvery };
}

function factOverlap(lists: Fact[][]): Overlap {
  const pairs: (number | null)[] = [];
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      const shared = matchFacts(lists[i], lists[j]).length;
      pairs.push(overlap(shared, lists[i].length, lists[j].length));
    }
  }
  return summarize(pairs);
}

/**
 * Compares runs of one race. Candidates are matched by name (case aside) and
 * listed in the first run's ballot order, then any the first run lacks. A
 * candidate's failed runs are left out of its overlap and counted as missing.
 */
export function compareRuns(races: readonly RaceDossier[]): StabilityReport {
  if (races.length < 2) throw new Error("comparing needs at least two runs");
  const key = (n: string) => n.trim().toLowerCase();
  const raceKey = (q: RaceQuery) =>
    [q.city, q.state, q.office, q.electionDate].map((x) => key(String(x ?? ""))).join("|");
  if (races.some((r) => raceKey(r.query) !== raceKey(races[0].query))) {
    throw new Error("these runs are not all of one race (city, state, office, or election differ)");
  }
  const names = new Map<string, string>();
  for (const r of races) {
    for (const d of r.candidates) {
      if (!names.has(key(d.candidate.name))) names.set(key(d.candidate.name), d.candidate.name);
    }
  }
  const candidates: CandidateStability[] = [...names].map(([k, name]) => {
    const dossiers = races.map((r) =>
      r.candidates.find((d) => key(d.candidate.name) === k && d.status === "ok")
    ).filter((d): d is CandidateDossier => !!d);
    const perRun = dossiers.map(sectionsOf);
    const keys = [...new Set(perRun.flatMap((s) => s.map((x) => x.key)))];
    const sections = keys.map((sk): SectionStability => {
      const lists = perRun.map((s) => s.find((x) => x.key === sk)?.facts ?? []);
      const title = perRun.flatMap((s) => s.filter((x) => x.key === sk))[0].title;
      return {
        key: sk,
        title,
        facts: lists.map((l) => l.length),
        found_in: lists.filter((l) => l.length).length,
        urls: urlOverlap(lists.map((l) => new Set(l.flatMap(urlsOf)))),
        fact_overlap: factOverlap(lists),
      };
    });
    const all = perRun.map((s) => s.flatMap((x) => x.facts));
    return {
      name,
      compared: dossiers.length,
      missing: races.length - dossiers.length,
      sections,
      urls: urlOverlap(all.map((l) => new Set(l.flatMap(urlsOf)))),
      fact_overlap: factOverlap(all),
    };
  });
  return {
    query: races[0].query,
    runs: races.length,
    generated_at: races.map((r) => r.generated_at),
    candidates,
    flips: candidates.flatMap((c) =>
      c.compared < 2 ? [] : c.sections
        .filter((s) => s.found_in > 0 && s.found_in < c.compared)
        .map((s) => ({ candidate: c.name, section: s.title, found_in: s.found_in }))
    ),
  };
}

const pct = (x: number | null) => x === null ? "n/a" : `${Math.round(x * 100)}%`;
const range = (o: Overlap) => o.mean === null ? "n/a" : `${pct(o.mean)} (lowest ${pct(o.min)})`;

export function formatStability(r: StabilityReport): string {
  const out: string[] = [];
  const q = r.query;
  out.push(`Stability: ${q.office}, ${q.city}, ${q.state}, ${q.electionDate}: ${r.runs} runs`);
  out.push(
    "Overlap is shared over all (Jaccard), mean over pairs of runs. Facts match by wording",
    `(at least ${Math.round(SAME_FACT * 100)}% of words alike), a heuristic: check the JSON.`,
    "",
  );
  for (const c of r.candidates) {
    out.push(`${c.name}`);
    if (c.compared < 2) {
      out.push(`  compared in ${c.compared} run(s) only (${c.missing} failed or missing)`, "");
      continue;
    }
    if (c.missing) out.push(`  ${c.missing} run(s) failed or missing, left out`);
    out.push(
      `  pages: ${range(c.urls)}; ${c.urls.in_every} of ${c.urls.union} kept in every run`,
      `  facts: ${range(c.fact_overlap)}`,
    );
    for (const s of c.sections) {
      if (!s.found_in) {
        out.push(`    ${s.title}: nothing found in any run`);
        continue;
      }
      const found = s.found_in === c.compared ? "" : `, found in ${s.found_in} of ${c.compared}`;
      out.push(
        `    ${s.title}: facts ${s.facts.join("/")}${found}; pages ${range(s.urls)}; facts ${
          range(s.fact_overlap)
        }`,
      );
    }
    out.push("");
  }
  out.push(
    r.flips.length
      ? `${r.flips.length} section(s) "Found" in some runs and "Nothing found" in others:`
      : `Every section reads "Found" or "Nothing found" the same in every run.`,
  );
  for (const f of r.flips) out.push(`  ${f.candidate}, ${f.section}: found in ${f.found_in}`);
  return out.join("\n");
}

/**
 * A rough cost per candidate research call, for the estimate printed before
 * anything is spent. Not measured: an assumption of a call that uses its
 * whole search cap (15) and resends a cached history across a few
 * continuations. The [usage] lines report what each call actually cost;
 * --per-candidate replaces this with your own figure.
 */
export const TYPICAL_CANDIDATE_USAGE = {
  requests: 4,
  input: 40_000,
  output: 15_000,
  cacheRead: 300_000,
  cacheWrite: 60_000,
  searches: 15,
  fetches: 10,
};
/** The ballot lookup, when no candidates are given: capped at 6 searches and 4 fetches. */
export const TYPICAL_BALLOT_USAGE = {
  requests: 2,
  input: 20_000,
  output: 4_000,
  cacheRead: 60_000,
  cacheWrite: 20_000,
  searches: 6,
  fetches: 4,
};

export interface Estimate {
  calls: number;
  /** Null for a model with no list price in the adapter. */
  dollars: number | null;
  per_candidate: number | null;
}

export function estimate(
  model: string,
  runs: number,
  candidates: number | null,
  perCandidate?: number,
): Estimate {
  const each = perCandidate ?? estimateCost(model, TYPICAL_CANDIDATE_USAGE);
  // The ballot lookup is priced at the model's list price even with --per-candidate.
  const ballot = candidates === null ? estimateCost(model, TYPICAL_BALLOT_USAGE) : 0;
  // Unknown candidate count: price a field of four, and say so.
  const n = candidates ?? 4;
  return {
    calls: runs * n + (candidates === null ? 1 : 0),
    dollars: each === null || ballot === null ? null : runs * n * each + ballot,
    per_candidate: each,
  };
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const USAGE = `Usage:
  deno task stability --city <city> --office <office> [--state CA] [--election 2026-11-03]
                      [--candidates "A;B"] [--incumbent "A"] [--priorities "x;y"]
                      [--runs 3] [--model ${DEFAULT_MODEL}] [--effort high]
                      [--per-candidate <usd>] [--out out/stability] [--yes]
  deno task stability --compare <run.json> <run.json> [...] [--json]

Without --yes it prints what the runs would cost and stops. With --yes it reruns the race's
research --runs times (no merge, context, or finance), saves each run, and reports how much the
verified pages and facts overlap. --compare does the same over saved runs and calls nothing.
Needs ANTHROPIC_API_KEY for a live run.`;

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: [
      "city",
      "state",
      "office",
      "election",
      "candidates",
      "incumbent",
      "priorities",
      "runs",
      "model",
      "effort",
      "per-candidate",
      "out",
    ],
    boolean: ["help", "yes", "compare", "json"],
    default: {
      state: "CA",
      election: "2026-11-03",
      runs: "3",
      effort: "high",
      out: "out/stability",
    },
  });
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const show = (r: StabilityReport) =>
    console.log(args.json ? JSON.stringify(r, null, 2) : formatStability(r));

  if (args.compare) {
    const files = args._.map(String);
    if (files.length < 2) {
      console.error("--compare needs two or more saved runs");
      return 2;
    }
    const races = await Promise.all(
      files.map(async (f) => raceOf(JSON.parse(await Deno.readTextFile(f)))),
    );
    show(compareRuns(races));
    return 0;
  }

  if (!args.city || !args.office) {
    console.error(USAGE);
    return 2;
  }
  const runs = Number(args.runs);
  if (!Number.isInteger(runs) || runs < 2) {
    console.error("--runs must be a whole number, 2 or more");
    return 2;
  }
  const perCandidate = args["per-candidate"] === undefined
    ? undefined
    : Number(args["per-candidate"]);
  if (perCandidate !== undefined && !(perCandidate >= 0)) {
    console.error("--per-candidate must be a dollar amount");
    return 2;
  }
  const parsed = parsePriorities(args.priorities ?? "");
  if (!parsed.ok) {
    console.error(`--priorities: ${parsed.error}`);
    return 2;
  }
  if (!(EFFORTS as readonly string[]).includes(args.effort)) {
    console.error(`--effort must be one of ${EFFORTS.join(", ")}`);
    return 2;
  }
  const model = args.model ?? DEFAULT_MODEL;
  const given = args.candidates ? parseCandidates(args.candidates, args.incumbent) : null;
  const est = estimate(model, runs, given?.length ?? null, perCandidate);
  const field = given ? `${given.length} candidate(s)` : "an unknown field (priced as 4)";
  console.log(
    `${runs} runs of ${field}: ${est.calls} research call(s), ${
      est.dollars === null
        ? perCandidate === undefined
          ? `no list price for ${model}; pass --per-candidate`
          : `no list price for ${model} to price the ballot lookup; pass --candidates`
        : `roughly $${est.dollars.toFixed(2)} at list prices (about $${
          est.per_candidate!.toFixed(2)
        } a candidate, an assumption, not a quote)`
    }.`,
  );
  if (!args.yes) {
    console.log("Nothing was spent. Add --yes to run it.");
    return 0;
  }
  if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("ANTHROPIC_AUTH_TOKEN")) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env or export it.");
    return 2;
  }

  const query: RaceQuery = {
    city: args.city,
    state: args.state.toUpperCase(),
    office: args.office,
    electionDate: args.election,
  };
  const researcher = new AnthropicResearcher({
    model,
    effort: args.effort as typeof EFFORTS[number],
    log: (m) => console.error(m),
  });
  // One list for every run, so a run differs only in its research.
  const listing = given ? null : await researcher.findBallot(query);
  const candidates = given ?? listing!.candidates;
  // runRace looks the ballot up again when handed no candidates, so an empty
  // list would give every run its own lookup: stop instead.
  if (!candidates.length) {
    console.error("The ballot lookup found no candidates; pass --candidates.");
    return 1;
  }
  const source: CandidateSource | undefined = listing
    ? {
      source_name: listing.source_name,
      order_basis: listing.order_basis,
      notes: listing.notes,
      ...(listing.contest_kind ? { contest_kind: listing.contest_kind } : {}),
    }
    : undefined;
  if (!given) {
    const found = estimate(model, runs, candidates.length, perCandidate);
    if (found.dollars !== null) {
      console.error(
        `Found ${candidates.length} candidate(s): ${found.calls} research call(s), roughly $${
          found.dollars.toFixed(2)
        } at list prices.`,
      );
    }
  }

  await Deno.mkdir(args.out, { recursive: true });
  const base = slug(`${query.city}-${query.office}-${query.electionDate}`);
  const races: RaceDossier[] = [];
  for (let i = 1; i <= runs; i++) {
    console.error(`Run ${i} of ${runs}...`);
    const race = await runRace(query, researcher, {
      candidates,
      candidateSource: source,
      priorities: parsed.issues,
      onProgress: (m) => console.error(m),
    });
    const file = `${args.out}/${base}-run-${i}.json`;
    await Deno.writeTextFile(file, JSON.stringify(race, null, 2));
    console.error(`Wrote ${file}`);
    races.push(race);
  }
  const report = compareRuns(races);
  await Deno.writeTextFile(`${args.out}/${base}-stability.json`, JSON.stringify(report, null, 2));
  show(report);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
