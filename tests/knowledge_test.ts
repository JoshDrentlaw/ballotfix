import { assert, assertEquals } from "@std/assert";
import { KNOWLEDGE_VERSION, nameKey, personRef, projectRace } from "../src/knowledge.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { openStores, type RunRecord } from "../src/web/store.ts";
import type { BallotCandidate, MeasureQuery, RaceDossier, RawFact } from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true },
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
];

const HERALD = "https://www.fontanaherald.com/news/budget";

function fact(statement: string, source_url: string, extra: Partial<RawFact> = {}): RawFact {
  return {
    statement,
    source_name: "Fontana Herald News",
    source_url,
    author: null,
    published: "2025-06-01",
    evidence_type: "reported",
    ...extra,
  };
}

/** Warren: two verified facts from one page, one unverified. Sida: one fact from the same page. */
async function race(): Promise<RaceDossier> {
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: {
        record: {
          facts: [fact("Voted for the 2025 budget.", HERALD)],
          searched: [],
          gap_note: null,
        },
        criticisms: {
          facts: [
            fact("Was criticized over a warehouse vote.", `${HERALD}?utm_source=x`),
            fact("Invented claim.", "https://example.com/never-fetched"),
          ],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: [HERALD],
    }),
    "Joz Sida": raw({
      sections: {
        platform: {
          facts: [fact("Opposes the 2025 budget.", HERALD)],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: [HERALD],
    }),
  });
  return await runRace(QUERY, port, { candidates: CANDS });
}

function doneRun(id: string, r: RaceDossier, created_at = "2026-10-01T00:00:00Z"): RunRecord {
  return {
    id,
    query: QUERY,
    candidates: CANDS,
    status: "done",
    created_at,
    updated_at: created_at,
    error: null,
    race: r,
  };
}

Deno.test("names that differ only in case, accents, or punctuation are one key", () => {
  assertEquals(nameKey("  José  O'Neil-Ruiz "), nameKey("jose o neil ruiz"));
  // Same name in another city is a different person until evidence says otherwise.
  assert(personRef("CA", "Fontana", "Joz Sida").key !== personRef("CA", "Rialto", "Joz Sida").key);
});

Deno.test("a race projects people, the office, relations, and every fact with provenance", async () => {
  const p = projectRace(await race());
  assertEquals(p.entities.map((e) => e.kind), ["office", "person", "person"]);
  const warren = personRef("CA", "Fontana", "Acquanetta Warren").key;
  assertEquals(
    p.relations.filter((r) => r.subject === warren).map((r) => [r.relation, r.detail]),
    [["candidate_for", "2026-11-03"], ["holds", "2026-11-03"]],
  );
  const mine = p.claims.filter((c) => c.subject === warren);
  assertEquals(mine.map((c) => [c.section, c.verified]), [
    ["record", true],
    ["criticisms", true],
    ["unverified", false],
  ]);
  // The utm_ variant is the same page.
  assertEquals(mine[0].citations[0].url_key, mine[1].citations[0].url_key);
  assertEquals(mine[0].citations[0].published, "2025-06-01");
});

Deno.test("only a finished run is indexed, and a page cited for two people is one source", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const kb = s.runs.knowledge;
  const r = await race();
  await s.runs.save({ ...doneRun("r-1", r), status: "running" });
  assertEquals(kb.stats().claims, 0);

  await s.runs.save(doneRun("r-1", r));
  assertEquals(kb.stats(), { entities: 3, claims: 4, sources: 2, relations: 3 });
  // Saving again replaces, rather than duplicates, what the run contributes.
  await s.runs.save(doneRun("r-1", r));
  assertEquals(kb.stats().claims, 4);

  const warren = kb.entity(personRef("CA", "Fontana", "Acquanetta Warren").key)!;
  const claims = kb.claimsAbout(warren.id);
  assertEquals(claims.map((c) => c.verified), [true, true, false]);
  assertEquals(claims[0].citations[0].source_name, "Fontana Herald News");

  const office = kb.linksOf(warren.id).find((l) => l.relation === "candidate_for")!.other;
  assertEquals(
    kb.linksOf(office.id).filter((l) => l.relation === "candidate_for").map((l) => l.other.name),
    ["Acquanetta Warren", "Joz Sida"],
  );

  // A second race for the same office reuses the same entities.
  await s.runs.save(doneRun("r-2", r, "2026-10-02T00:00:00Z"));
  assertEquals(kb.stats().entities, 3);
  assertEquals(kb.claimsAbout(warren.id).map((c) => c.run_id).slice(0, 1), ["r-2"]);
  s.db.close();
});

Deno.test("a finished measure is indexed under its label, jurisdiction, and election", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const m: MeasureQuery = {
    label: "Measure X",
    jurisdiction: "City of Fontana",
    question: "Shall the city...",
    state: "CA",
    electionDate: "2026-11-03",
  };
  const url = "https://www.fontanaca.gov/measure-x.pdf";
  const result = await runMeasure(
    m,
    new FakeResearch(listing([]), {}, {
      "Measure X": rawMeasure({
        sections: {
          effect: {
            facts: [fact("Raises the sales tax.", url, { evidence_type: "primary_record" })],
            searched: [],
            gap_note: null,
          },
        },
        retrieved_urls: [url],
      }),
    }),
  );
  await s.runs.save({
    id: "m-1",
    query: { ...QUERY, city: m.jurisdiction, office: m.label },
    measure: m,
    measure_result: result,
    candidates: null,
    status: "done",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    race: null,
  });
  const e = s.runs.knowledge.entity("measure:ca|city of fontana|2026 11 03|measure x")!;
  assertEquals(e.kind, "measure");
  assertEquals(s.runs.knowledge.claimsAbout(e.id).map((c) => c.evidence_type), ["primary_record"]);
  s.db.close();
});

Deno.test("JSON files from earlier versions are imported once and indexed", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/ballots`);
  await Deno.mkdir(`${dir}/choices`);
  const run = doneRun("old-run", await race());
  await Deno.writeTextFile(`${dir}/old-run.json`, JSON.stringify(run));
  await Deno.writeTextFile(`${dir}/broken.json`, "{not json");
  await Deno.writeTextFile(
    `${dir}/choices/old-run.json`,
    JSON.stringify({
      id: "old-run",
      created_at: "x",
      updated_at: "x",
      picks: ["Joz Sida"],
      notes: "",
    }),
  );

  const logs: string[] = [];
  const s = await openStores(dir, { log: (m) => logs.push(m) });
  assertEquals((await s.runs.get("old-run"))?.race?.candidates.length, 2);
  assertEquals((await s.choices.get("old-run"))?.picks, ["Joz Sida"]);
  assertEquals(s.runs.knowledge.stats().claims, 4);
  assert(logs.some((l) => l.startsWith("Imported 2 saved record(s)")));
  // The files are left where they were.
  await Deno.stat(`${dir}/old-run.json`);

  // A later edit isn't clobbered by the files on the next start.
  await s.choices.save({
    id: "old-run",
    created_at: "x",
    updated_at: "y",
    picks: ["Acquanetta Warren"],
    notes: "",
  });
  s.db.close();
  const again = await openStores(dir);
  assertEquals((await again.choices.get("old-run"))?.picks, ["Acquanetta Warren"]);
  again.db.close();
});

Deno.test("the graph is rebuilt from saved runs when the projection version changes", async () => {
  const dir = await Deno.makeTempDir();
  const s = await openStores(dir);
  await s.runs.save(doneRun("r-1", await race()));
  s.db.run("DELETE FROM claims");
  s.db.setMeta("knowledge_version", "0");
  s.db.close();

  const again = await openStores(dir);
  assertEquals(again.db.meta("knowledge_version"), String(KNOWLEDGE_VERSION));
  assertEquals(again.runs.knowledge.stats().claims, 4);
  again.db.close();
});
