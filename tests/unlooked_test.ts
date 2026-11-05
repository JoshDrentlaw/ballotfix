/**
 * Same names never looked up (roadmap item 17): a name in support facts of
 * two or more items without a sourced note in one of them is listed by its
 * words only, never as a tie or a shared entity.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ballotConnections, type BallotItemDossier, unlookedNames } from "../src/finance.ts";
import { onBallot } from "../src/onballot.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { ballotSharedHtml, onBallotHtml } from "../src/render.ts";
import type {
  BallotCandidate,
  ContextNote,
  MeasureDossier,
  RaceDossier,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, raw, rawMeasure } from "./fakes.ts";

const PAGE = "https://inlanddaily.example/endorsements";

const fact = (statement: string): RawFact => ({
  statement,
  source_name: "Inland Daily",
  source_url: PAGE,
  author: null,
  published: "2026-09-01",
  evidence_type: "reported",
});
const section = (...s: string[]) => ({ facts: s.map(fact), searched: [], gap_note: null });

async function race(
  city: string,
  office: string,
  endorsements: Record<string, string[]>,
): Promise<RaceDossier> {
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
        raw({ sections: { endorsements: section(...s) }, retrieved_urls: [PAGE] }),
      ]),
    ),
  );
  const q = { city, state: "CA", office, electionDate: "2026-11-03" };
  return await runRace(q, port, { candidates: cands });
}

async function measure(label: string, cases: { for: string; against: string }) {
  const q = {
    label,
    jurisdiction: "California",
    question: "",
    state: "CA",
    electionDate: "2026-11-03",
  };
  const port = new FakeResearch(listing([]), {}, {
    [label]: rawMeasure({
      sections: { case_for: section(cases.for), case_against: section(cases.against) },
      retrieved_urls: [PAGE],
    }),
  });
  return await runMeasure(q, port);
}

const noted = (name: string): ContextNote => ({
  name,
  kind: "organization",
  note: `${name} is a group.`,
  source_name: "Example",
  source_url: "https://example.org/about",
  author: null,
  published: null,
  verified: true,
});

function withNotes<T extends RaceDossier | MeasureDossier>(d: T, names: string[]): T {
  return {
    ...d,
    context: { notes: names.map(noted), not_looked_up: [], not_described: [], model: "test" },
  };
}

async function ballot(): Promise<BallotItemDossier[]> {
  return [
    {
      heading: "City Clerk",
      runId: "clerk",
      race: await race("Fontana", "City Clerk", {
        "Germaine Key": [
          "Key was endorsed by the Inland Empire Labor Council and the City Clerk.",
          "Inland Daily reported that Key spoke at a forum.",
        ],
        "Joe Alvanez": [
          "Alvanez is backed by Indivisible Marin and Treasurer Kamal Namou.",
          "U.S. Senator Alex Padilla backs Alvanez.",
        ],
      }),
    },
    {
      heading: "City Treasurer",
      runId: "treasurer",
      race: await race("Fontana", "City Treasurer", {
        "Kamal Namou": [
          "Namou was endorsed by the Inland Empire Labor Council.",
          "Germaine Key praised Namou.",
        ],
      }),
    },
    {
      heading: "Proposition 42",
      runId: "p42",
      measure: await measure("Proposition 42", {
        for: "Indivisible Marin, Alex Padilla, and SEIU-UHW support it; the General Fund gains.",
        against: "Opposed by the Inland Empire Labor Council Steering Committee.",
      }),
    },
  ];
}

Deno.test("a name in two items' support facts with no note is listed, every holder in ballot order", async () => {
  const u = unlookedNames(await ballot());
  assertEquals(u.map((x) => x.name), [
    "U.S. Senator Alex Padilla",
    "Indivisible Marin",
    "Inland Empire Labor Council",
  ]);
  const labor = u[2];
  assertEquals(labor.holders.map((h) => [h.item, h.label, h.noted]), [
    ["City Clerk", "Germaine Key", false],
    ["City Treasurer", "Kamal Namou", false],
  ]);
  // A longer name holding this one is said to be possibly the same, never merged.
  assertEquals(labor.close, ["Inland Empire Labor Council Steering Committee"]);
  // A title before the name is not part of it.
  assertEquals(u[0].holders.map((h) => h.item), ["City Clerk", "Proposition 42"]);
  assertEquals(u[1].holders.map((h) => h.item), ["City Clerk", "Proposition 42"]);
});

Deno.test("offices, laws, outlets, one-word names, and the ballot's candidates are left out", async () => {
  const names = unlookedNames(await ballot()).map((x) => x.name);
  for (
    const n of [
      "City Clerk",
      "Treasurer",
      "General Fund",
      "Inland Daily",
      "Kamal Namou",
      "Germaine Key",
    ]
  ) {
    assert(!names.includes(n), n);
  }
  // SEIU-UHW is one word but an acronym; it is in only one item here, so not listed.
  assert(!names.includes("SEIU-UHW"));
});

Deno.test("a name noted in every item it appears in is matched, not listed; noted in one, it is listed and says so", async () => {
  const items = await ballot();
  const all = items.map((it) =>
    it.race
      ? { ...it, race: withNotes(it.race, ["Inland Empire Labor Council"]) }
      : { ...it, measure: withNotes(it.measure!, []) }
  );
  assert(!unlookedNames(all).some((x) => x.name === "Inland Empire Labor Council"));
  const one = [
    { ...items[0], race: withNotes(items[0].race!, ["Inland Empire Labor Council"]) },
    ...items.slice(1),
  ];
  const labor = unlookedNames(one).find((x) => x.name === "Inland Empire Labor Council")!;
  assertEquals(labor.holders.map((h) => h.noted), [true, false]);
});

Deno.test("the Researched tab and On this ballot list them folded, never as shared", async () => {
  const items = await ballot();
  const c = ballotConnections(items);
  assertEquals(c.shared, []);
  const html = ballotSharedHtml(c);
  assertStringIncludes(
    html,
    "Shared across this ballot (none found · 3 same names without a note)",
  );
  assertStringIncludes(html, "Same name, no sourced note");
  assertStringIncludes(html, "a lead to check, not a connection");
  assertStringIncludes(html, "Possibly the same as Inland Empire Labor Council Steering Committee");

  const o = onBallot(items, 1);
  assertEquals(o.unlooked.map((x) => x.name), ["Inland Empire Labor Council"]);
  const page = onBallotHtml(o, (id) => `/races/${id}`);
  assertStringIncludes(page, "1 same name without a note");
  assertStringIncludes(page, "Namou was endorsed by the Inland Empire Labor Council.");
});

Deno.test("the ballot's places in either form, and qualifiers without a title, stay as written", async () => {
  const items: BallotItemDossier[] = [
    {
      heading: "Mayor",
      runId: "mayor",
      race: await race("Fontana", "Mayor", {
        "Ann Lee": [
          "Lee is backed by the City of Fontana firefighters, the U.S. Chamber of Commerce, and Justice for Janitors.",
        ],
      }),
    },
    {
      heading: "County Supervisor",
      runId: "sup",
      race: await race("County of San Bernardino", "Supervisor", {
        "Bob Ray": [
          "Ray spoke at City of Fontana Hall; the Chamber of Commerce, San Bernardino County, and Justice for Janitors back him.",
        ],
      }),
    },
  ];
  const names = unlookedNames(items).map((x) => x.name);
  assert(!names.includes("City of Fontana"), "a race's city in its City of form");
  assert(!names.includes("San Bernardino County"), "a County of place in its X County form");
  // "U.S." comes off only before a title: the U.S. Chamber is not a local Chamber of Commerce.
  assert(!names.includes("U.S. Chamber of Commerce"));
  assert(names.includes("Justice for Janitors"));
});

Deno.test("a name holding a noted one is tied already; a Fund is a committee; the very same shared name is close", async () => {
  const two = async (a: string, b: string) => [
    { heading: "Mayor", runId: "mayor", race: await race("Fontana", "Mayor", { "Ann Lee": [a] }) },
    {
      heading: "Clerk",
      runId: "clerk",
      race: await race("Fontana", "City Clerk", { "Bob Ray": [b] }),
    },
  ];
  const sierra = await two(
    "Lee is endorsed by Sierra Club California.",
    "Ray is endorsed by Sierra Club California.",
  );
  const noted = sierra.map((it) => ({ ...it, race: withNotes(it.race, ["Sierra Club"]) }));
  assertEquals(unlookedNames(noted), []);

  const fund = await two(
    "Planned Parenthood Action Fund backs Lee; the General Fund pays for it.",
    "Planned Parenthood Action Fund backs Ray.",
  );
  assertEquals(unlookedNames(fund).map((x) => x.name), ["Planned Parenthood Action Fund"]);

  const items = await ballot();
  const shared = [{
    ref: {
      kind: "organization" as const,
      key: "k",
      name: "Inland Empire Labor Council",
      scope: "ca|fontana",
      place: "Fontana",
    },
    holders: [],
  }];
  const labor = unlookedNames(items, shared).find((x) => x.name === "Inland Empire Labor Council")!;
  assertEquals(labor.close, [
    "Inland Empire Labor Council",
    "Inland Empire Labor Council Steering Committee",
  ]);
});
