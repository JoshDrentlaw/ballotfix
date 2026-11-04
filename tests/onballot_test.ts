/**
 * "On this ballot": facts that name another item on the ballot, either way,
 * and groups tied to this item and to others, from saved research only.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { contextForMeasure, contextForRace } from "../src/context.ts";
import type { BallotItemDossier } from "../src/finance.ts";
import { measurePattern, nameParts, namesPerson, onBallot } from "../src/onballot.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { onBallotHtml } from "../src/render.ts";
import type {
  BallotCandidate,
  ContextWriter,
  MeasureDossier,
  RaceDossier,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, raw, rawMeasure } from "./fakes.ts";

const PAGE = "https://www.example-news.com/ballot";
const SOS = "https://cal-access.sos.ca.gov/committee/123";

const fact = (statement: string): RawFact => ({
  statement,
  source_name: "Example News",
  source_url: PAGE,
  author: null,
  published: "2026-09-01",
  evidence_type: "reported",
});
const section = (...statements: string[]) => ({
  facts: statements.map(fact),
  searched: [],
  gap_note: null,
});

const notes: ContextWriter = {
  describeNames: (req) =>
    Promise.resolve({
      notes: req.names.map((n) => ({
        id: n.id,
        kind: "organization",
        note: "A political group.",
        source_name: "California Secretary of State",
        source_url: SOS,
        author: null,
        published: null,
      })),
      retrieved_urls: [SOS],
      model: "fake",
    }),
};

async function measure(label: string, cases: { for: string; against: string }) {
  const q = {
    label,
    jurisdiction: "State of California",
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
  return (await contextForMeasure(await runMeasure(q, port), notes)).dossier as MeasureDossier;
}

async function race(endorsements: Record<string, string>): Promise<RaceDossier> {
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
        raw({ sections: { endorsements: section(s) }, retrieved_urls: [PAGE] }),
      ]),
    ),
  );
  const q = {
    city: "State of California",
    state: "CA",
    office: "Clerk",
    electionDate: "2026-11-03",
  };
  return (await contextForRace(await runRace(q, port, { candidates: cands }), notes)).dossier;
}

Deno.test("a measure's label is found as facts write it, and not inside another number", () => {
  const p = measurePattern("Proposition 40");
  for (
    const yes of [
      "Proposition 40 would tax billionaires.",
      "It would cancel Prop. 40 if it gets more votes.",
      "Opponents of Props. 41 and 40 met.",
      "Propositions 40, 41 and 42 are linked.",
      "The guide says Yes on 40.",
      "The group urges No on Prop 40.",
      "Proposition 40's backers said so.",
    ]
  ) assert(p.test(yes), yes);
  for (
    const no of [
      "Proposition 400 is a different one.",
      "Prop 4 passed in 2024.",
      "Proposition 41 would block it.",
      "Props 41 and 42 were placed together.",
      "about 40 groups and a proposition",
    ]
  ) assert(!p.test(no), no);
  const local = measurePattern("Measure A");
  assert(local.test("Voters rejected Measure A."));
  assert(local.test("Measures B and A share a donor."));
  assert(!local.test("a measure as broad as this"));
  assert(!measurePattern("Measure I").test("She backed Prop 50 and I think it passes."));
});

Deno.test("a candidate is named by a given name and the surname together, never the surname alone", () => {
  const vara = nameParts(`ALEJANDRO "ALEX" VARA`)!;
  assert(namesPerson("The union backs Alex Vara.", vara));
  assert(namesPerson("Alejandro Vara's office said no.", vara));
  const key = nameParts("GERMAINE KEY")!;
  assert(!namesPerson("The key vote was close.", key));
  assert(!namesPerson("Key said it would pass.", key));
  assert(namesPerson("Germaine Key filed on time.", key));
  const rod = nameParts("VICTOR HUGO RODRIGUEZ")!;
  assert(namesPerson("Victor Hugo Rodriguez spoke.", rod));
  assert(namesPerson("Victor H. Rodriguez spoke.", rod));
  assert(!namesPerson("Victor met with the city and Rodriguez.", rod));
  assertEquals(nameParts("CHER"), null);
  const leon = nameParts("KEVIN DE LEÓN")!;
  assert(namesPerson("Kevin de León voted no.", leon));
  assert(!namesPerson("De León voted no.", leon));
  const cruz = nameParts("MARIA DE LA CRUZ")!;
  assert(namesPerson("Maria de la Cruz said so.", cruz));
  assert(!namesPerson("Councilmember de la Cruz said so.", cruz));
  const lopez = nameParts("MARY LOPEZ")!;
  assert(!namesPerson("Supervisors Mary Brown, Jose Lopez backed it.", lopez));
  assert(!namesPerson("It was Mary. Lopez said no.", lopez));
  assert(namesPerson("Jane Doe backed it.", nameParts("JANE DOE MD")!));
});

Deno.test("each item lists the facts that name another item, either way, and groups tied to others", async () => {
  const items: BallotItemDossier[] = [
    {
      heading: "City Clerk",
      runId: "rc",
      race: await race({
        "JOE ALVANEZ": "The Inland Workers Union endorses Joe Alvanez and Yes on 40.",
        "GERMAINE KEY": "Key is endorsed by the Fontana Herald.",
      }),
    },
    {
      heading: "Proposition 40",
      runId: "r40",
      measure: await measure("Proposition 40", {
        for: "Supported by the Inland Workers Union.",
        against: "Opposed by the Taxpayers League.",
      }),
    },
    {
      heading: "Proposition 42",
      runId: "r42",
      measure: await measure("Proposition 42", {
        for: "Supported by the Growth Council.",
        against: "Opponents say Prop. 42 is a poison pill aimed at Prop 40.",
      }),
    },
    {
      heading: "Proposition 43",
      runId: "r43",
      measure: await measure("Proposition 43", {
        for: "Supported by the Growth Council.",
        against: "Opposed by the Library Friends.",
      }),
    },
  ];
  const o = onBallot(items, 1);
  // Its own item never; Prop 43 names nothing and shares nothing with Prop 40.
  assertEquals(o.items.map((x) => x.heading), ["City Clerk", "Proposition 42"]);
  assertEquals(o.items[0].named, []);
  assertEquals(o.items[0].namedBy.map((m) => [m.subject, m.section]), [
    ["JOE ALVANEZ", "endorsements"],
  ]);
  assertEquals(o.items[1].namedBy.map((m) => m.section), ["case_against"]);
  assertEquals(o.groups.map((g) => g.ref.name), ["Inland Workers Union"]);
  assertEquals(o.groups[0].holders.map((h) => h.item), ["City Clerk", "Proposition 40"]);

  const page = onBallotHtml(o, (id) => `/races/${id}`);
  assertStringIncludes(page, "On this ballot (2 items named · 1 group tied to others)");
  assertStringIncludes(page, `href="/races/r42#m--case-against"`);
  assertStringIncludes(page, `href="/races/rc#joe-alvanez--endorsements"`);
  assertStringIncludes(page, "Example News");

  // From the race: Joe Alvanez's fact names Prop 40, linked within the page.
  const clerk = onBallot(items, 0);
  assertEquals(clerk.items.map((x) => [x.heading, x.named.length]), [["Proposition 40", 1]]);
  assertStringIncludes(
    onBallotHtml(clerk, (id) => `/races/${id}`),
    `href="#joe-alvanez--endorsements"`,
  );

  // Prop 43 shares a group with Prop 42 only.
  const p43 = onBallot(items, 3);
  assertEquals(p43.items, []);
  assertEquals(p43.groups.map((g) => g.ref.name), ["Growth Council"]);
});

Deno.test("an item with no connection says what was compared; a lone item shows nothing", async () => {
  const lone: BallotItemDossier = {
    heading: "Proposition 43",
    runId: "r43",
    measure: await measure("Proposition 43", {
      for: "Supported by the Growth Council.",
      against: "Opposed by the Library Friends.",
    }),
  };
  assertEquals(onBallotHtml(onBallot([lone], 0), (id) => id), "");
  // Others started but not done (or not loadable): the box says so rather than vanishing.
  const waiting = onBallotHtml(onBallot([lone], 0), (id) => id, {
    notCompared: ["City Clerk"],
    unreadable: ["Proposition 40"],
  });
  assertStringIncludes(waiting, "No other item on this ballot has finished research yet");
  assertStringIncludes(waiting, "couldn&#39;t be read: Proposition 40.");
  const other: BallotItemDossier = {
    heading: "Proposition 37",
    runId: "r37",
    measure: await measure("Proposition 37", {
      for: "Supported by the Carpenters Council.",
      against: "Opposed by the Budget Center.",
    }),
  };
  const page = onBallotHtml(onBallot([lone, other], 0), (id) => id, {
    notCompared: ["City Clerk"],
  });
  assertStringIncludes(page, "On this ballot (nothing found)");
  assertStringIncludes(page, "Of the 1 other researched item, no fact here names one");
  assertStringIncludes(page, "Not compared, because their research isn&#39;t done: City Clerk.");
});
