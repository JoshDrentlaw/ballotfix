/**
 * The merge step: which proposed groups stand, how a merged fact renders and
 * indexes, and how the job runner calls it once per finished run.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { personRef } from "../src/knowledge.ts";
import { MAX_MERGE_FACTS, mergeMeasure, mergeRace } from "../src/merge.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { openStores } from "../src/web/store.ts";
import type {
  BallotCandidate,
  ClaimMerger,
  MeasureQuery,
  MergeBlock,
  RaceDossier,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true },
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
];

const HERALD = "https://www.fontanaherald.com/news/budget";
const PE = "https://www.pe.com/2025/06/02/fontana-budget";
const KVCR = "https://kvcrnews.org/fontana-budget";
const CITY = "https://www.fontanaca.gov/minutes-2025-06";
const HERALD2 = "https://www.fontanaherald.com/news/budget-followup";
const NEVER = "https://example.com/never-fetched";

function fact(statement: string, source_url: string, source_name: string, extra = {}): RawFact {
  return {
    statement,
    source_name,
    source_url,
    author: null,
    published: "2025-06-01",
    evidence_type: "reported",
    ...extra,
  };
}

const section = (...facts: RawFact[]) => ({ facts, searched: [], gap_note: null });

/**
 * Warren's record: the budget vote reported by three outlets (one of them twice),
 * the minutes as a primary record, and a fact that only cites a page never retrieved.
 * Sida's record states the same vote in the same words, from the same outlets.
 */
async function race(): Promise<RaceDossier> {
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: {
        record: section(
          fact("Voted for the 2025 budget.", HERALD, "Fontana Herald News"),
          fact("Approved the city's 2025 budget.", PE, "Press-Enterprise"),
          fact("Cast a yes vote on the 2025 budget.", HERALD2, "Fontana Herald News"),
          fact("Voted yes on the 2025 budget.", CITY, "City of Fontana", {
            evidence_type: "primary_record",
          }),
          fact("Backed the 2025 budget.", KVCR, "KVCR"),
          fact("Voted for the 2025 budget, per a blog.", NEVER, "A blog"),
        ),
        criticisms: section(fact("Was criticized over a warehouse vote.", PE, "Press-Enterprise")),
      },
      retrieved_urls: [HERALD, PE, KVCR, CITY, HERALD2],
    }),
    "Joz Sida": raw({
      sections: {
        record: section(
          fact("Voted for the 2025 budget.", HERALD, "Fontana Herald News"),
          fact("Approved the city's 2025 budget.", PE, "Press-Enterprise"),
        ),
      },
      retrieved_urls: [HERALD, PE],
    }),
  });
  return await runRace(QUERY, port, { candidates: CANDS });
}

/** Answers with fixed groups, written in terms of statements so tests read plainly. */
class FakeMerger implements ClaimMerger {
  calls: MergeBlock[][] = [];
  constructor(readonly pick: (blocks: MergeBlock[]) => string[][]) {}
  groupDuplicates(blocks: MergeBlock[]): Promise<string[][]> {
    this.calls.push(blocks);
    return Promise.resolve(this.pick(blocks));
  }
}

const idsWhere = (blocks: MergeBlock[], label: string, test: (s: string) => boolean) =>
  blocks.filter((b) => b.label.startsWith(label)).flatMap((b) =>
    b.facts.filter((f) => test(f.statement)).map((f) => f.id)
  );
const budget = (s: string) => s.includes("2025 budget");

Deno.test("only verified facts in sections with two or more outlets are sent, in one call", async () => {
  const r = await race();
  const m = new FakeMerger(() => []);
  const out = await mergeRace(r, m);
  assertEquals(m.calls.length, 1);
  const [blocks] = m.calls;
  assertEquals(blocks.map((b) => b.label), [
    "Acquanetta Warren — Record in this office",
    "Joz Sida — Record in this office",
  ]);
  // The unverified blog fact is never sent; criticisms has one fact and isn't either.
  assert(!blocks.flatMap((b) => b.facts).some((f) => f.source_name === "A blog"));
  assertEquals(out.sent, 7);
  assertEquals(out.groups, 0);
  assertEquals(out.dossier, r);
});

Deno.test("nothing worth merging means no call at all", async () => {
  const port = new FakeResearch(listing(CANDS.slice(0, 1)), {
    "Acquanetta Warren": raw({
      sections: { record: section(fact("Voted for the 2025 budget.", HERALD, "Herald")) },
      retrieved_urls: [HERALD],
    }),
  });
  const m = new FakeMerger(() => [["f1"]]);
  const out = await mergeRace(await runRace(QUERY, port, { candidates: CANDS.slice(0, 1) }), m);
  assertEquals(m.calls.length, 0);
  assertEquals(out.sent, 0);
});

Deno.test("a group becomes one fact with every outlet, earliest first, one per outlet and type", async () => {
  const r = await race();
  const out = await mergeRace(r, new FakeMerger((b) => [idsWhere(b, "Acquanetta", budget)]));
  // Reported: Herald, P-E, KVCR (Herald's second page dropped). Primary record stays its own fact.
  assertEquals(out.groups, 1);
  const facts = out.dossier.candidates[0].sections.record.facts;
  assertEquals(facts.map((f) => f.statement), [
    "Voted for the 2025 budget.",
    "Cast a yes vote on the 2025 budget.",
    "Voted yes on the 2025 budget.",
  ]);
  assertEquals(facts[0].also?.map((f) => f.source_name), ["Press-Enterprise", "KVCR"]);
  assertEquals(facts[1].also, undefined);
  // The unverified list and the other candidate are untouched.
  assertEquals(out.dossier.candidates[0].unverified, r.candidates[0].unverified);
  assertEquals(out.dossier.candidates[1], r.candidates[1]);
});

Deno.test("groups across people or sections are dropped whole; unknown and reused ids are ignored", async () => {
  const r = await race();
  const out = await mergeRace(
    r,
    new FakeMerger((b) => {
      const warren = idsWhere(b, "Acquanetta", budget), sida = idsWhere(b, "Joz", budget);
      return [
        [warren[0], sida[0]], // two people: never merged
        ["f999", warren[0]], // unknown id leaves one: not a group
        [warren[0], warren[1]],
        [warren[1], warren[4]], // warren[1] is already in a group
      ];
    }),
  );
  assertEquals(out.groups, 1);
  assertEquals(out.dossier.candidates[0].sections.record.facts[0].also?.length, 1);
  assertEquals(out.dossier.candidates[1], r.candidates[1]);
});

Deno.test("facts past the cap are left unmerged rather than sent", async () => {
  const many = Array.from(
    { length: MAX_MERGE_FACTS + 1 },
    (_, i) => fact(`Fact ${i}.`, `https://news${i}.example/a`, `Outlet ${i}`),
  );
  const port = new FakeResearch(listing(CANDS.slice(0, 1)), {
    "Acquanetta Warren": raw({
      sections: { record: section(...many) },
      retrieved_urls: many.map((f) => f.source_url),
    }),
  });
  const m = new FakeMerger(() => []);
  const out = await mergeRace(await runRace(QUERY, port, { candidates: CANDS.slice(0, 1) }), m);
  assertEquals(m.calls.length, 0);
  assertEquals(out.skipped, MAX_MERGE_FACTS + 1);
});

Deno.test("a merged fact renders once as reported by N sources, escaped, with each source", async () => {
  const r = await race();
  r.candidates[0].sections.record.facts[1].source_name = "<script>P-E</script>";
  const out = await mergeRace(r, new FakeMerger((b) => [idsWhere(b, "Acquanetta", budget)]));
  const html = renderRace(out.dossier);
  assertStringIncludes(html, "Reported by 3 sources");
  assertStringIncludes(html, "&lt;script&gt;P-E&lt;/script&gt;");
  assert(!html.includes("<script>P-E"));
  assertStringIncludes(html, `href="${KVCR}"`);
  // Sida's identical facts weren't grouped, so they still show twice.
  assertEquals(html.split("Reported by").length - 1, 1);
});

Deno.test("a merged fact is one claim in the graph citing every source", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const out = await mergeRace(
    await race(),
    new FakeMerger((b) => [idsWhere(b, "Acquanetta", budget)]),
  );
  await s.runs.save({
    id: "r-1",
    query: QUERY,
    candidates: CANDS,
    status: "done",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    race: out.dossier,
  });
  const kb = s.runs.knowledge;
  const warren = kb.entity(personRef("CA", "Fontana", "Acquanetta Warren").key)!;
  const claims = kb.claimsAbout(warren.id);
  const vote = claims.find((c) => c.statement === "Voted for the 2025 budget.")!;
  assertEquals(vote.citations.length, 3);
  assertEquals(vote.verified, true);
  // Record: 3 facts; criticisms: 1; unverified: 1.
  assertEquals(claims.length, 5);
  assertEquals(claims.filter((c) => !c.verified).length, 1);
  s.db.close();
});

Deno.test("a measure merges within its own sections", async () => {
  const q: MeasureQuery = {
    label: "Measure X",
    jurisdiction: "City of Fontana",
    question: "",
    state: "CA",
    electionDate: "2026-11-03",
  };
  const port = new FakeResearch(listing([]), {}, {
    "Measure X": rawMeasure({
      sections: {
        effect: section(
          fact("Raises the sales tax by 1 cent.", HERALD, "Herald"),
          fact("Adds one cent to the sales tax.", PE, "P-E"),
        ),
      },
      retrieved_urls: [HERALD, PE],
    }),
  });
  const m = await runMeasure(q, port);
  const out = await mergeMeasure(m, new FakeMerger((b) => [b[0].facts.map((f) => f.id)]));
  assertEquals(out.groups, 1);
  assertEquals(out.dossier.sections.effect.facts.length, 1);
});

Deno.test("the job runner merges after saving the run as done, and a failed merge leaves it done", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: {
        record: section(
          fact("Voted for the 2025 budget.", HERALD, "Herald"),
          fact("Approved the 2025 budget.", PE, "P-E"),
        ),
      },
      retrieved_urls: [HERALD, PE],
    }),
  });
  const statusAtMerge: (string | undefined)[] = [];
  let fail = false;
  const logs: string[] = [];
  const jobs = new JobRunner(s.runs, () => port, {
    log: (m) => logs.push(m),
    makeMerger: () => ({
      groupDuplicates: async (blocks) => {
        statusAtMerge.push((await s.runs.list())[0]?.status);
        if (fail) throw new Error("overloaded");
        return [blocks[0].facts.map((f) => f.id)];
      },
    }),
  });
  const run = await jobs.submit(QUERY, CANDS);
  await jobs.idle();
  assertEquals(statusAtMerge, ["done"]);
  const saved = (await s.runs.get(run.id))!;
  assertEquals(saved.status, "done");
  assertEquals(saved.race!.candidates[0].sections.record.facts[0].also?.length, 1);

  fail = true;
  const second = await jobs.submit(QUERY, CANDS);
  await jobs.idle();
  const kept = (await s.runs.get(second.id))!;
  assertEquals(kept.status, "done");
  assertEquals(kept.race!.candidates[0].sections.record.facts.length, 2);
  assert(logs.some((l) => l.includes("merging duplicate claims failed: overloaded")));
  s.db.close();
});
