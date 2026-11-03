import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { personRef } from "../src/knowledge.ts";
import { runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import { type BallotRecord, openStores, placeRun, type RunRecord } from "../src/web/store.ts";
import type { BallotCandidate, RaceDossier, RaceQuery } from "../src/types.ts";
import { FakeResearch, listing, raw } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Richard Barrera", ballot_designation: null, incumbent: false },
  { name: "Sonja Shaw", ballot_designation: null, incumbent: false },
];
const PAGE = "https://example.org/superintendent";

function query(city: string, office: string): RaceQuery {
  return { city, state: "CA", office, electionDate: "2026-11-03" };
}

async function race(q: RaceQuery): Promise<RaceDossier> {
  const fact = {
    statement: "Spoke at a forum.",
    source_name: "Example News",
    source_url: PAGE,
    author: null,
    published: "2026-10-01",
    evidence_type: "reported" as const,
  };
  const research = (name: string) =>
    raw({
      sections: {
        record: { facts: [{ ...fact, statement: `${name} spoke.` }], searched: [], gap_note: null },
      },
      retrieved_urls: [PAGE],
    });
  const port = new FakeResearch(listing(CANDS), {
    "Richard Barrera": research("Richard Barrera"),
    "Sonja Shaw": research("Sonja Shaw"),
  });
  return await runRace(q, port, { candidates: CANDS });
}

async function run(id: string, city: string, office: string, ballot = true): Promise<RunRecord> {
  const q = query(city, office);
  return {
    id,
    query: q,
    ballot: ballot ? { id: "ballot-1", key: "10", vote_for: 1 } : null,
    candidates: CANDS,
    status: "done",
    created_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T00:00:00Z",
    error: null,
    race: await race(q),
  };
}

const BALLOT: BallotRecord = {
  id: "ballot-1",
  status: "read",
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
  error: null,
  pages: 1,
  reading: {
    election_date: "2026-11-03",
    state: "CA",
    county: "San Bernardino",
    contests: [],
    measures: [],
    notes: null,
    model: "test",
  },
  started: {},
};

Deno.test("a race saved with a ballot heading as its place is read as the office's government", async () => {
  const cases: [string, string, string][] = [
    ["School Offices", "Superintendent of Public Instruction", "State of California"],
    ["School Offices", "County Superintendent of Schools", "San Bernardino County"],
    ["City of Fontana Offices", "City Clerk", "City of Fontana"],
    [
      "District Offices",
      "Member, Board of Directors Division 4, Inland Empire Utilities Agency",
      "Inland Empire Utilities Agency",
    ],
  ];
  for (const [saved, office, read] of cases) {
    const r = placeRun(await run("r", saved, office), "San Bernardino");
    assertEquals([r.query.city, r.query.place_as_saved], [read, saved], office);
    assertEquals(r.race?.query.city, read);
    // Read again, it stays put: the heading is what's read, never the reading.
    assertEquals(placeRun(r, "San Bernardino"), r);
  }
});

Deno.test("a place that stands, a measure, and a run without a ballot are left as saved", async () => {
  const fine = await run("r", "State of California", "Superintendent of Public Instruction");
  assertEquals(placeRun(fine, "San Bernardino"), fine);
  const typed = await run("r", "School Offices", "Superintendent of Public Instruction", false);
  assertEquals(placeRun(typed, "San Bernardino"), typed);
  const measure: RunRecord = {
    ...fine,
    query: query("Measures", "Measure X"),
    measure: {
      label: "Measure X",
      question: "Shall the city adopt Measure X?",
      jurisdiction: "City of Fontana",
      state: "CA",
      electionDate: "2026-11-03",
    },
  };
  assertEquals(placeRun(measure, "San Bernardino"), measure);
  // A retention question keeps its saved place, as research again offers it.
  const kept = await run("r", "Judicial", "Associate Justice, Court of Appeal");
  const retention: RunRecord = {
    ...kept,
    candidate_source: {
      source_name: "ballot",
      order_basis: "official_ballot_order",
      notes: null,
      contest_kind: "retention",
    },
  };
  assertEquals(placeRun(retention, "San Bernardino"), retention);
  // A place that differs from ballotPlace's only in spaces stands, never a heading.
  const spaced = await run("r", "City of Fontana ", "City Clerk");
  assertEquals(placeRun(spaced, "San Bernardino"), spaced);
});

Deno.test("the store reads the corrected place, leaves the saved body alone, and the graph agrees", async () => {
  const dir = await Deno.makeTempDir();
  const s = await openStores(dir);
  await s.ballots.save(BALLOT);
  await s.runs.save(await run("r-1", "School Offices", "Superintendent of Public Instruction"));

  const got = (await s.runs.get("r-1"))!;
  assertEquals([got.query.city, got.query.place_as_saved], [
    "State of California",
    "School Offices",
  ]);
  assertEquals((await s.runs.list())[0].query.city, "State of California");
  // What was saved is unchanged.
  const body = JSON.parse(String(s.db.get("SELECT body FROM runs WHERE id = 'r-1'")!.body));
  assertEquals(body.query.city, "School Offices");
  assertEquals(body.query.place_as_saved, undefined);

  const state = personRef("CA", "State of California", "Sonja Shaw").key;
  const heading = personRef("CA", "School Offices", "Sonja Shaw").key;
  assert(s.runs.knowledge.entity(state));
  assertEquals(s.runs.knowledge.entity(heading), null);

  // A rebuild reads runs the same way.
  s.db.setMeta("knowledge_version", "0");
  s.db.close();
  const again = await openStores(dir);
  assert(again.runs.knowledge.entity(state));
  assertEquals(again.runs.knowledge.entity(heading), null);
  again.db.close();

  // The page says the place was read, not saved, that way.
  const page = renderRace(got.race!);
  assertStringIncludes(
    page,
    "State of California, CA (saved as “School Offices”, a ballot heading",
  );
});

Deno.test("a race started after places were fixed keeps the place it was given", async () => {
  // E.g. "Research again" with a place the voter typed, which may look like a heading.
  const later = {
    ...(await run("r", "Mountain Offices", "Superintendent of Public Instruction")),
    created_at: "2026-11-01T00:00:00Z",
  };
  assertEquals(placeRun(later, "San Bernardino"), later);
});

Deno.test("saving a run that was read stores its saved place, never the reading", async () => {
  const s = await openStores(await Deno.makeTempDir());
  await s.ballots.save(BALLOT);
  await s.runs.save(await run("r-1", "School Offices", "Superintendent of Public Instruction"));
  // A later step reads the run and saves it again, as the job runner does.
  const read = (await s.runs.get("r-1"))!;
  assertEquals(read.query.city, "State of California");
  await s.runs.save({ ...read, updated_at: "2026-10-30T00:00:00Z" });
  const body = JSON.parse(String(s.db.get("SELECT body FROM runs WHERE id = 'r-1'")!.body));
  assertEquals([body.query.city, body.query.place_as_saved], ["School Offices", undefined]);
  assertEquals([body.race.query.city, body.race.query.place_as_saved], [
    "School Offices",
    undefined,
  ]);
  assertEquals(body.updated_at, "2026-10-30T00:00:00Z");
  // And it still reads, and indexes, as the state's.
  assertEquals((await s.runs.get("r-1"))!.query.city, "State of California");
  assert(s.runs.knowledge.entity(personRef("CA", "State of California", "Sonja Shaw").key));
  s.db.close();
});
