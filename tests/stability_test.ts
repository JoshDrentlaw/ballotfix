/**
 * The stability run and the answer-key scoring: overlap between runs of one
 * race, and precision and recall against a person's judgments. Built from
 * runs made with the fake port, so nothing is spent.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  compareRuns,
  estimate,
  formatStability,
  matchFacts,
  raceOf,
  similarity,
  TYPICAL_CANDIDATE_USAGE,
  TYPICAL_SHARED_USAGE,
} from "../src/stability.ts";
import {
  type AnswerKey,
  rate,
  type ReviewSheet,
  sampleSheet,
  scorePrecision,
  scoreRecall,
} from "../src/answer_key.ts";
import { DEFAULT_SHARED_MODEL, estimateCost } from "../src/research/anthropic.ts";
import { runRace } from "../src/race.ts";
import type { BallotCandidate, Fact, RaceDossier, RawFact } from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw } from "./fakes.ts";

const A: BallotCandidate = { name: "Ana Reyes", ballot_designation: null, incumbent: false };
const B: BallotCandidate = { name: "Bo Smith", ballot_designation: null, incumbent: false };

const fact = (statement: string, url: string): RawFact => ({
  statement,
  source_name: "Fontana Herald News",
  source_url: url,
  author: null,
  published: "2026-09-01",
  evidence_type: "reported",
});

const VOTE = "Reyes voted against the 2025 warehouse rezoning on Sierra Avenue.";
const VOTE_REWORDED = "Reyes voted against the 2025 Sierra Avenue warehouse rezoning.";
const CLINIC = "Reyes founded a free legal clinic for tenants in 2019.";
const AWARD = "Reyes received the chamber of commerce small business award in 2022.";

async function run(
  aFacts: Record<string, RawFact[]>,
  bFacts: Record<string, RawFact[]> | Error,
): Promise<RaceDossier> {
  const research = (facts: Record<string, RawFact[]>) =>
    raw({
      sections: Object.fromEntries(
        Object.entries(facts).map(([k, f]) => [k, { facts: f, searched: [], gap_note: null }]),
      ),
      retrieved_urls: Object.values(facts).flat().map((f) => f.source_url),
    });
  const port = new FakeResearch(listing([A, B]), {
    [A.name]: research(aFacts),
    [B.name]: bFacts instanceof Error ? bFacts : research(bFacts),
  });
  return await runRace(QUERY, port, { candidates: [A, B] });
}

Deno.test("similarity compares words, not text, and keeps numbers", () => {
  assert(similarity(VOTE, VOTE_REWORDED) >= 0.9);
  assert(similarity(VOTE, CLINIC) < 0.3);
  assert(similarity("Voted for Measure X in 2024", "Voted for Measure X in 2025") < 1);
  assertEquals(similarity("", VOTE), 0);
});

Deno.test("facts match one to one, best first", () => {
  const f = (statement: string) => ({ statement } as Fact);
  const pairs = matchFacts([f(VOTE), f(CLINIC)], [f(VOTE_REWORDED), f(VOTE), f(AWARD)]);
  // The reworded vote has the same words: a tie, broken by order, and the exact copy is left.
  assertEquals(pairs, [[0, 0]]);
});

Deno.test("compareRuns reports page and fact overlap per section, and Found that flips", async () => {
  const r1 = await run(
    {
      background: [fact(CLINIC, "https://herald.example/clinic")],
      record: [fact(VOTE, "https://herald.example/vote")],
      accomplishments: [fact(AWARD, "https://chamber.example/award")],
    },
    { background: [fact("Smith is a retired firefighter.", "https://herald.example/smith")] },
  );
  const r2 = await run(
    {
      background: [fact(CLINIC, "https://www.herald.example/clinic/")],
      record: [fact(VOTE_REWORDED, "https://other.example/vote")],
    },
    new Error("boom"),
  );
  const rep = compareRuns([r1, r2]);
  assertEquals(rep.runs, 2);
  const ana = rep.candidates[0];
  assertEquals(ana.name, "Ana Reyes");
  assertEquals(ana.compared, 2);
  const sec = (k: string) => ana.sections.find((s) => s.key === k)!;
  // Same page once normalized: full overlap.
  assertEquals(sec("background").urls.mean, 1);
  assertEquals(sec("background").fact_overlap.mean, 1);
  // Same fact from another page: facts overlap, pages don't.
  assertEquals(sec("record").urls.mean, 0);
  assertEquals(sec("record").fact_overlap.mean, 1);
  // Found in one run only.
  assertEquals(sec("accomplishments").found_in, 1);
  assertEquals(sec("accomplishments").facts, [1, 0]);
  // Nothing either time: agreement, not an overlap figure.
  assertEquals(sec("criticisms").urls.mean, null);
  assertEquals(sec("criticisms").found_in, 0);
  assertEquals(ana.urls.union, 4);
  assertEquals(ana.urls.in_every, 1);
  assertEquals(rep.flips, [{ candidate: "Ana Reyes", section: "Accomplishments", found_in: 1 }]);
  // A failed run is left out, not counted as finding nothing.
  const bo = rep.candidates[1];
  assertEquals(bo.compared, 1);
  assertEquals(bo.missing, 1);
  const text = formatStability(rep);
  assert(text.includes("compared in 1 run(s) only"));
  assert(text.includes("Accomplishments: found in 1"));
  assertThrows(() => compareRuns([r1]));
});

Deno.test("raceOf reads a dossier or the app's run record", async () => {
  const r = await run({}, {});
  assertEquals(raceOf(r), r);
  assertEquals(raceOf({ id: "x", race: r }), r);
  assertThrows(() => raceOf({ id: "x", race: null }));
});

Deno.test("estimate prices every run's candidates, the shared pass once, and the ballot lookup when none are given", () => {
  const each = estimateCost("claude-opus-5-5", TYPICAL_CANDIDATE_USAGE)!;
  const shared = estimateCost(DEFAULT_SHARED_MODEL, TYPICAL_SHARED_USAGE)!;
  const given = estimate("claude-opus-5-5", 3, 2);
  assertEquals(given.calls, 7);
  assertEquals(given.dollars, 6 * each + shared);
  const found = estimate("claude-opus-5-5", 3, null);
  assertEquals(found.calls, 14);
  assert(found.dollars! > 12 * each + shared);
  assertEquals(estimate("claude-opus-5-5", 2, 2, 0.5).dollars, 2 + shared);
  // A field of one gets no shared pass.
  assertEquals(estimate("claude-opus-5-5", 2, 1).calls, 2);
  assertEquals(estimate("some-unpriced-model", 2, 2).dollars, null);
});

Deno.test("a review sheet is a seeded uniform sample of verified facts, each once", async () => {
  const r = await run(
    {
      background: [fact(CLINIC, "https://herald.example/clinic")],
      record: [fact(VOTE, "https://herald.example/vote")],
      accomplishments: [fact(AWARD, "https://chamber.example/award")],
    },
    { background: [fact("Smith is a retired firefighter.", "https://herald.example/smith")] },
  );
  const now = new Date("2026-10-30T00:00:00Z");
  const s = sampleSheet(r, 2, 7, now);
  assertEquals(s.drawn_from, 4);
  assertEquals(s.items.length, 2);
  assertEquals(sampleSheet(r, 2, 7, now), s);
  assert(s.items.every((i) => i.judgment === "" && i.check_level !== undefined));
  assertEquals(sampleSheet(r, 10, 7, now).items.length, 4);
  // Every fact is reachable from some seed.
  const seen = new Set<string>();
  for (let seed = 0; seed < 40; seed++) {
    for (const i of sampleSheet(r, 1, seed, now).items) seen.add(i.statement);
  }
  assertEquals(seen.size, 4);
});

Deno.test("precision counts judged items only, with an interval and by quote level", () => {
  const item = (judgment: string, level: string | null) => ({
    id: `f${Math.random()}`,
    candidate: "Ana Reyes",
    section: "Who they are",
    statement: "x",
    source_name: "x",
    source_url: "https://x.example",
    quote: null,
    check_level: level,
    judgment,
    note: "",
  });
  const sheet = {
    query: QUERY,
    generated_at: "",
    seed: 1,
    drawn_from: 9,
    instructions: "",
    items: [
      item("supported", "quoted"),
      item("supported", "quoted"),
      item("not_supported", "seen"),
      item("wrong_person", "quoted"),
      item("unsure", "quoted"),
      item("", null),
      item("maybe", null),
    ],
  } as ReviewSheet;
  const p = scorePrecision(sheet);
  assertEquals(p.precision.hits, 2);
  assertEquals(p.precision.of, 4);
  assertEquals(p.counts.unjudged, 1);
  assertEquals(p.invalid.length, 1);
  assertEquals(p.by_level.quoted.of, 3);
  assertEquals(p.by_level.seen.hits, 0);
  assert(p.precision.low! < 0.5 && p.precision.high! > 0.5);
  assertEquals(rate(0, 0).rate, null);
  const all = rate(10, 10);
  assertEquals(all.rate, 1);
  assert(all.low! < 1 && all.high === 1);
});

Deno.test("recall matches the owner's key by page, then by wording, within a section", async () => {
  const r = await run(
    {
      background: [fact(CLINIC, "https://herald.example/clinic")],
      record: [fact(VOTE, "https://herald.example/vote")],
    },
    new Error("boom"),
  );
  const key: AnswerKey = {
    query: { city: "Fontana", office: "Mayor" },
    items: [
      {
        candidate: "ana reyes",
        statement: "Started a tenant clinic",
        urls: ["http://herald.example/clinic/"],
      },
      { candidate: "Ana Reyes", section: "record", statement: VOTE_REWORDED },
      { candidate: "Ana Reyes", section: "criticisms", statement: VOTE_REWORDED },
      { candidate: "Ana Reyes", section: "nonsense", statement: VOTE },
      { candidate: "Bo Smith", statement: "Retired firefighter" },
      { candidate: "Cy Nobody", statement: "Anything" },
    ],
  };
  const rep = scoreRecall(r, key);
  assertEquals(rep.mismatch, null);
  assertEquals(rep.results.map((x) => x.found), ["url", "wording", null, null, null, null]);
  assertEquals(rep.results[3].problem, 'no section "nonsense"');
  assert(rep.results[4].problem!.includes("failed"));
  assert(rep.results[5].problem!.includes("no candidate"));
  assertEquals(rep.recall.hits, 2);
  // A key typo or a failed candidate isn't a miss: left out of the rate.
  assertEquals(rep.recall.of, 3);
  assertEquals(rep.by_candidate.map((c) => c.name), ["Ana Reyes", "Bo Smith", "Cy Nobody"]);
  assertEquals(rep.by_candidate[0].recall.of, 3);
  assertEquals(rep.by_candidate[1].recall.of, 0);
  const other = scoreRecall(r, { query: { city: "Rialto" }, items: [] });
  assert(other.mismatch!.includes("city"));
  assertThrows(() => scoreRecall(r, { items: [{ candidate: 1 }] } as unknown as AnswerKey));
});

Deno.test("review fixes: runs of different races don't compare, and a fact answers one key item", async () => {
  const r = await run({ record: [fact(VOTE, "https://herald.example/vote")] }, {});
  assertThrows(() => compareRuns([r, { ...r, query: { ...r.query, city: "Rialto" } }]));
  const rep = scoreRecall(r, {
    items: [
      { candidate: "Ana Reyes", statement: "One vote", urls: ["https://herald.example/vote"] },
      { candidate: "Ana Reyes", statement: "Another vote", urls: ["https://herald.example/vote"] },
    ],
  });
  assertEquals(rep.results.map((x) => x.found), ["url", null]);
});
