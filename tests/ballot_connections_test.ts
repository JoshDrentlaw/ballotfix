/**
 * Shared across a ballot: what candidates and sides of different items share,
 * matched by the same entity keys the race and measure pages use, on the
 * ballot's Researched tab.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { contextForMeasure, contextForRace } from "../src/context.ts";
import { ballotConnections, type BallotItemDossier, financeForMeasure } from "../src/finance.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { ballotSharedHtml } from "../src/render.ts";
import { type PickItem, researchedPage } from "../src/web/pages.ts";
import type { BallotRecord, RunRecord } from "../src/web/store.ts";
import type {
  BallotCandidate,
  ContextWriter,
  FinanceResearcher,
  MeasureDossier,
  RaceDossier,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, raw, rawMeasure } from "./fakes.ts";

const HERALD = "https://www.fontanaherald.com/news/endorsements";
const SOS = "https://cal-access.sos.ca.gov/committee/123";
const FILING = "https://public.netfile.com/pub2/filing/123.pdf";

const fact = (statement: string): RawFact => ({
  statement,
  source_name: "Fontana Herald News",
  source_url: HERALD,
  author: null,
  published: "2026-09-01",
  evidence_type: "reported",
});
const section = (...facts: RawFact[]) => ({ facts, searched: [], gap_note: null });

const notes: ContextWriter = {
  describeNames: (req) =>
    Promise.resolve({
      notes: req.names.map((n) => ({
        id: n.id,
        kind: "organization",
        note: "A political action committee.",
        source_name: "California Secretary of State",
        source_url: SOS,
        author: null,
        published: null,
      })),
      retrieved_urls: [SOS],
      model: "fake",
    }),
};

async function race(city: string, endorsements: Record<string, string>): Promise<RaceDossier> {
  const cands: BallotCandidate[] = Object.keys(endorsements).map((name) => ({
    name,
    ballot_designation: null,
    incumbent: false,
  }));
  const port = new FakeResearch(
    listing(cands),
    Object.fromEntries(
      Object.entries(endorsements).map(([name, s]) => [
        name,
        raw({ sections: { endorsements: section(fact(s)) }, retrieved_urls: [HERALD] }),
      ]),
    ),
  );
  const q = { city, state: "CA", office: "Council", electionDate: "2026-11-03" };
  return (await contextForRace(await runRace(q, port, { candidates: cands }), notes)).dossier;
}

/** A measure whose supporters got money from `donor`, with each side's case as given. */
async function measure(
  label: string,
  jurisdiction: string,
  cases: { for: string; against: string },
  donor?: string,
): Promise<MeasureDossier> {
  const q = { label, jurisdiction, question: "", state: "CA", electionDate: "2026-11-03" };
  const port = new FakeResearch(listing([]), {}, {
    [label]: rawMeasure({
      sections: {
        case_for: section(fact(cases.for)),
        case_against: section(fact(cases.against)),
      },
      retrieved_urls: [HERALD],
    }),
  });
  const m = (await contextForMeasure(await runMeasure(q, port), notes)).dossier;
  if (!donor) return m;
  const money: FinanceResearcher = {
    findContributions: (req) =>
      Promise.resolve({
        subjects: req.subjects.filter((s) => s.role === "support").map((s) => ({
          id: s.id,
          committees: [],
          searched: [],
          gap_note: "",
          not_listed: "",
          totals: [],
          contributions: [{
            filer: `Yes on ${label}`,
            contributor: donor,
            contributor_type: "organization",
            occupation: "",
            employer: "",
            amount: "$5,000",
            date: "09/14/2026",
            filing_period: "",
            filing: "Form 460",
            source_name: "NetFile",
            source_url: FILING,
          }],
        })),
        portal_gaps: [],
        retrieved_urls: [FILING],
        model: "fake",
      }),
  };
  return (await financeForMeasure(m, money)).dossier;
}

Deno.test("an entity tied to subjects of two items is listed once, every holder in ballot order", async () => {
  const items: BallotItemDossier[] = [
    {
      heading: "Proposition 37",
      runId: "r37",
      measure: await measure("Proposition 37", "State of California", {
        for: "Supported by the Carpenters Council.",
        against: "Opposed by the Howard Jarvis Taxpayers Association.",
      }),
    },
    {
      heading: "Proposition 43",
      runId: "r43",
      measure: await measure("Proposition 43", "California", {
        for: "Supported by the Howard Jarvis Taxpayers Association.",
        against: "Opposed by the League of Women Voters.",
      }),
    },
  ];
  const c = ballotConnections(items);
  assertEquals(c.subjects, 4);
  assertEquals(c.places, 2);
  // "State of California" and "California" are different places by the graph's rule.
  assertEquals(c.shared, []);
  assertEquals(c.possible.map((g) => g.map((x) => `${x.item} · ${x.label}`)), [[
    "Proposition 37 · Opponents",
    "Proposition 43 · Supporters",
  ]]);

  items[1].measure = await measure("Proposition 43", "State of California", {
    for: "Supported by the Howard Jarvis Taxpayers Association.",
    against: "Opposed by the League of Women Voters.",
  });
  const same = ballotConnections(items);
  assertEquals(same.places, 1);
  assertEquals(same.shared.map((x) => x.ref.name), ["Howard Jarvis Taxpayers Association"]);
  assertEquals(same.shared[0].holders.map((h) => `${h.item} · ${h.label}`), [
    "Proposition 37 · Opponents",
    "Proposition 43 · Supporters",
  ]);
  const html = ballotSharedHtml(same);
  assertStringIncludes(html, "Shared across this ballot (1 found)");
  assertStringIncludes(html, "Proposition 37 · Opponents:");
  assertStringIncludes(html, "named in The case against");
  assert(!html.includes("different places"));
});

Deno.test("a contributor to one side and an endorser of another are one entity in one place", async () => {
  const c = ballotConnections([
    {
      heading: "City Council",
      runId: "rc",
      race: await race("Fontana", { "Jane Roe": "Endorsed by Inland Builders PAC." }),
    },
    {
      heading: "Measure X",
      runId: "rx",
      measure: await measure("Measure X", "City of Fontana", {
        for: "Supported by Friends of Fontana Parks.",
        against: "Opposed by the Fontana Taxpayers Association.",
      }, "Inland Builders PAC"),
    },
  ]);
  assertEquals(c.shared.length, 1);
  assertEquals(c.shared[0].holders.map((h) => [h.label, h.ties.map((t) => t.kind)]), [
    ["Jane Roe", ["named"]],
    ["Supporters", ["contribution"]],
  ]);
  assertStringIncludes(ballotSharedHtml(c), "contribution of $5,000");
});

Deno.test("sharing within one item only is left to that item's page", async () => {
  const c = ballotConnections([
    {
      heading: "City Council",
      runId: "rc",
      race: await race("Fontana", {
        "Jane Roe": "Endorsed by Inland Builders PAC.",
        "Sam Poe": "Endorsed by Inland Builders PAC.",
      }),
    },
    {
      heading: "School Board",
      runId: "rs",
      race: await race("Fontana Unified School District", {
        "Ann Lee": "Endorsed by Inland Builders PAC.",
      }),
    },
  ]);
  assertEquals(c.shared, []);
  // The same name in another place is a possible match, never a match.
  assertEquals(c.possible[0].map((x) => x.label), ["Jane Roe", "Sam Poe", "Ann Lee"]);
  const html = ballotSharedHtml(c);
  assertStringIncludes(html, "none found");
  assertStringIncludes(html, "in 2 different places");
  assertStringIncludes(html, "Inland Builders PAC (School Board · Ann Lee)");
});

Deno.test("the Researched tab shows what the ballot's finished items share, and escapes it", async () => {
  const run = (id: string, key: string, m: MeasureDossier): RunRecord => ({
    id,
    query: { city: m.query.jurisdiction, state: "CA", office: m.query.label, electionDate: "" },
    measure: m.query,
    measure_result: m,
    candidates: null,
    status: "done",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    race: null,
    ballot: { id: "b1", key, vote_for: 1 },
  });
  const who = "Smith & Jones Builders";
  const a = await measure("Measure A", "Fontana", {
    for: `Supported by ${who}.`,
    against: "Opposed by Nobody Inc.",
  });
  const b = await measure("Measure B", "Fontana", {
    for: "Supported by Somebody Inc.",
    against: `Opposed by ${who}.`,
  });
  const item = (key: string, heading: string, r: RunRecord): PickItem => ({
    key,
    options: ["Yes", "No"],
    max: 1,
    heading,
    detail: "Fontana",
    run: r,
    choice: null,
    choiceId: r.id,
  });
  const ballot: BallotRecord = {
    id: "b1",
    status: "read",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    pages: 1,
    reading: null,
    started: { m0: "ra", m1: "rb" },
  };
  const page = researchedPage(ballot, [
    item("m0", "Measure A", run("ra", "m0", a)),
    item("m1", "Measure B", run("rb", "m1", b)),
  ], { entityHref: (key) => key.includes("smith") ? "/entities/x" : null });
  assertStringIncludes(page, "Shared across this ballot (1 found)");
  assertStringIncludes(page, `<a class="ent" href="/entities/x">Smith &amp; Jones Builders</a>`);
  assert(!page.includes("Smith & Jones"));
});
