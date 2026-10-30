/**
 * The quote check (roadmap item 3): each verified fact's quote is looked for
 * on the page the session opened, and the fact gets a level and, when the
 * page doesn't name its subject, a flag. Covers assembly, merging, the page,
 * and the graph.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assembleCandidate,
  assembleMeasure,
  MAX_QUOTE_LENGTH,
  measureSubject,
  quoteOnPage,
  surname,
} from "../src/dossier.ts";
import { projectRace } from "../src/knowledge.ts";
import { mergeRace } from "../src/merge.ts";
import { runRace } from "../src/race.ts";
import { renderMeasure, renderRace } from "../src/render.ts";
import type { BallotCandidate, ClaimMerger, MeasureQuery, RawFact } from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const WARREN: BallotCandidate = {
  name: "Acquanetta Warren",
  ballot_designation: "Mayor",
  incumbent: true,
};

const HERALD = "https://www.fontanaherald.com/news/budget";
const PE = "https://www.pe.com/2025/06/02/fontana-budget";
const PDF = "https://www.fontanaca.gov/minutes.pdf";
const SNIPPET = "https://kvcrnews.org/fontana-budget";
const NEVER = "https://example.com/never-fetched";

const HERALD_TEXT = `# Council passes budget

Mayor Acquanetta **Warren** said the city “will not raise taxes —
this year or next,” before the [council](https://www.fontanaherald.com/council) voted 4-1.`;
const PE_TEXT = "The council approved a $1.2 billion budget on a 4-1 vote Tuesday night.";

function fact(source_url: string, quote: string, extra: Partial<RawFact> = {}): RawFact {
  return {
    statement: "Said the city will not raise taxes.",
    source_name: "Fontana Herald News",
    source_url,
    author: null,
    published: "2025-06-01",
    evidence_type: "reported",
    quote,
    ...extra,
  };
}

const section = (...facts: RawFact[]) => ({ facts, searched: [], gap_note: null });

function warren(facts: RawFact[]) {
  return assembleCandidate(
    WARREN,
    raw({
      sections: { record: section(...facts) },
      retrieved_urls: [HERALD, PE, PDF, SNIPPET],
      opened_pages: [
        { url: HERALD, text: HERALD_TEXT },
        { url: PE, text: PE_TEXT },
        { url: PDF, text: null },
      ],
    }),
  );
}

Deno.test("a quote matches across case, curly quotes, dashes, line breaks, and markdown", () => {
  assert(quoteOnPage(`The city "will not raise taxes - this year or next."`, HERALD_TEXT));
  assert(quoteOnPage("before the council voted 4-1", HERALD_TEXT));
  assertEquals(quoteOnPage("the city will raise taxes this year", HERALD_TEXT), false);
  // Words must be whole: "counci" is not "council".
  assertEquals(quoteOnPage("before the counci voted 4 1", HERALD_TEXT), false);
});

Deno.test("an ellipsis-joined quote must have every piece, in order; a short one isn't checked", () => {
  // The minimum is for the whole quote, so a short invented piece still fails.
  assertEquals(
    quoteOnPage("will not raise taxes this year ... and invented twelve", HERALD_TEXT),
    false,
  );
  assert(
    quoteOnPage("will not raise taxes this year ... before the council voted 4-1", HERALD_TEXT),
  );
  assertEquals(
    quoteOnPage("before the council voted 4-1 ... will not raise taxes this year", HERALD_TEXT),
    false,
  );
  assertEquals(quoteOnPage("raise taxes", HERALD_TEXT), null);
  assert(quoteOnPage("will not raise taxes this year … voted", HERALD_TEXT));
  assertEquals(quoteOnPage("raise ... taxes", HERALD_TEXT), null);
});

Deno.test("each verified fact gets a level; an unverified one gets none", () => {
  const d = warren([
    fact(HERALD, "will not raise taxes, this year or next"),
    fact(PE, "The council rejected the budget on a 4-1 vote"),
    fact(PE, ""),
    fact(PDF, "the council voted to approve the budget"),
    fact(SNIPPET, "approved the budget"),
    fact(NEVER, "anything at all goes here"),
  ]);
  assertEquals(d.sections.record.facts.map((f) => f.check), [
    { level: "quoted", opened: true, read: true },
    // PE's page never names Warren: flagged, not dropped.
    { level: "not_found", opened: true, read: true, missing_name: "Warren" },
    { level: "seen", opened: true, read: true, missing_name: "Warren" },
    { level: "seen", opened: true, read: false },
    { level: "seen", opened: false, read: false },
  ]);
  assertEquals(d.sections.record.facts[0].quote, "will not raise taxes, this year or next");
  assert(!("quote" in d.sections.record.facts[2]));
  assertEquals(d.unverified.length, 1);
  assert(!("check" in d.unverified[0]));
});

Deno.test("page text is used for the check and never kept on the dossier", () => {
  const d = warren([fact(HERALD, "will not raise taxes, this year or next")]);
  const json = JSON.stringify(d);
  assert(!json.includes("billion"));
  assert(!json.includes("opened_pages"));
});

Deno.test("a quote over the length limit isn't kept, and is never cut", () => {
  const d = warren([fact(HERALD, "x ".repeat(MAX_QUOTE_LENGTH))]);
  const f = d.sections.record.facts[0];
  assert(!("quote" in f));
  assertEquals(f.check?.level, "seen");
});

Deno.test("the name check looks for the surname, past suffixes, and a measure's other names", () => {
  assertEquals(surname("Robert “Bob” Smith Jr."), "Smith");
  assertEquals(surname("María García-López, III"), "García-López");
  assertEquals(surname("Cher"), "Cher");
  assertEquals(measureSubject("Proposition 50", null).terms, [
    "Proposition 50",
    "Prop 50",
    "Proposition 50",
  ]);
  const m: MeasureQuery = {
    label: "Prop. 50",
    jurisdiction: "State of California",
    question: "",
    state: "CA",
    electionDate: "2025-11-04",
  };
  const page = "https://www.sos.ca.gov/prop50";
  const d = assembleMeasure(
    m,
    rawMeasure({
      official_title: "Election Rigging Response Act",
      sections: {
        effect: section(
          fact(page, "", { statement: "Changes district maps." }),
          fact(`${page}/other`, "", { statement: "Changes district maps, per a page." }),
        ),
      },
      retrieved_urls: [page, `${page}/other`],
      opened_pages: [
        { url: page, text: "Proposition 50 asks voters to approve temporary maps." },
        { url: `${page}/other`, text: "A page about something else entirely." },
      ],
    }),
    [],
    new Date("2025-10-01T00:00:00Z"),
  );
  assertEquals(d.sections.effect.facts.map((f) => f.check?.missing_name), [undefined, "Prop. 50"]);
});

Deno.test("YES and NO meanings get the same quote check as any fact", () => {
  const m: MeasureQuery = {
    label: "Measure X",
    jurisdiction: "City of Fontana",
    question: "",
    state: "CA",
    electionDate: "2026-11-03",
  };
  const page = "https://www.fontanaca.gov/measure-x";
  const text = "Measure X. A YES vote means the city sales tax rises by one cent.";
  const d = assembleMeasure(
    m,
    rawMeasure({
      vote_means: {
        yes: fact(page, "A YES vote means the city sales tax rises by one cent", {
          statement: "A YES vote means the sales tax rises by one cent.",
        }),
        no: fact(page, "A NO vote means the tax stays where it is today", {
          statement: "A NO vote means the tax stays as it is.",
        }),
      },
      retrieved_urls: [page],
      opened_pages: [{ url: page, text }],
    }),
    [],
    new Date("2026-10-01T00:00:00Z"),
  );
  assertEquals(d.vote_means?.yes?.check?.level, "quoted");
  assertEquals(d.vote_means?.no?.check?.level, "not_found");
  const html = renderMeasure(d);
  assertStringIncludes(html, "Quote found on page");
  assertStringIncludes(html, "The quote given, not found on the page");
});

/** A merger that groups every fact it is sent into one group per block. */
const groupAll: ClaimMerger = {
  groupDuplicates: (blocks) => Promise.resolve(blocks.map((b) => b.facts.map((f) => f.id))),
};

Deno.test("the merge step only groups facts with the same check", async () => {
  const port = new FakeResearch(listing([WARREN]), {
    [WARREN.name]: raw({
      sections: {
        record: section(
          fact(HERALD, "will not raise taxes, this year or next"),
          fact(PE, "Warren said she would not raise taxes", { source_name: "Press-Enterprise" }),
          fact(SNIPPET, "", { source_name: "KVCR" }),
          fact(PDF, "", { source_name: "City of Fontana" }),
          fact(`${SNIPPET}-2`, "", { source_name: "Inland Daily" }),
        ),
      },
      retrieved_urls: [HERALD, PE, PDF, SNIPPET, `${SNIPPET}-2`],
      opened_pages: [{ url: HERALD, text: HERALD_TEXT }, { url: PE, text: PE_TEXT }, {
        url: PDF,
        text: null,
      }],
    }),
  });
  const r = await runRace(QUERY, port);
  const { dossier, groups } = await mergeRace(r, groupAll);
  // Quoted (Herald) and not_found (PE) stay apart. Of the three "seen" facts, the two
  // search results merge; the opened PDF says something else on its chip, so it stays apart.
  assertEquals(groups, 1);
  const facts = dossier.candidates[0].sections.record.facts;
  assertEquals(facts.map((f) => [f.check?.level, f.check?.opened, f.also?.length ?? 0]), [
    ["quoted", true, 0],
    ["not_found", true, 0],
    ["seen", false, 1],
    ["seen", true, 0],
  ]);
});

Deno.test("the page shows each level, the quote collapsed, and the name flag", async () => {
  const port = new FakeResearch(listing([WARREN]), {
    [WARREN.name]: raw({
      sections: {
        record: section(
          fact(HERALD, "will not raise taxes, this year or next"),
          fact(PE, "The council rejected the budget <b>outright</b>"),
          fact(SNIPPET, ""),
          fact(PDF, ""),
        ),
      },
      retrieved_urls: [HERALD, PE, PDF, SNIPPET],
      opened_pages: [{ url: HERALD, text: HERALD_TEXT }, { url: PE, text: PE_TEXT }, {
        url: PDF,
        text: null,
      }],
    }),
  });
  const html = renderRace(await runRace(QUERY, port));
  assertStringIncludes(html, `<span class="chk chk-quoted">Quote found on page</span>`);
  assertStringIncludes(html, `<span class="chk chk-not_found">Quote not found on page</span>`);
  assertStringIncludes(html, `<span class="chk chk-seen">Search result only</span>`);
  assertStringIncludes(html, `<span class="chk chk-seen">Page opened, quote not checked</span>`);
  assertStringIncludes(html, `<details class="quote"><summary>Quote from the page</summary>`);
  assertStringIncludes(html, "page doesn't mention “Warren”");
  // Quotes are research content: escaped like everything else.
  assertStringIncludes(html, "&lt;b&gt;outright&lt;/b&gt;");
  assert(!html.includes("<b>outright</b>"));
  assert(!html.includes("checked before quote checks existed"));
});

Deno.test("a run saved before quote checks says so once, and shows no level", async () => {
  const port = new FakeResearch(listing([WARREN]), {
    [WARREN.name]: raw({
      sections: { record: section(fact(HERALD, "")) },
      retrieved_urls: [HERALD],
    }),
  });
  const r = await runRace(QUERY, port);
  // What an older saved run looks like: verified facts without a check.
  for (const f of r.candidates[0].sections.record.facts) delete f.check;
  const html = renderRace(r);
  assertStringIncludes(html, "This run was checked before quote checks existed");
  // The reading guide's legend shows each chip once; no fact shows one.
  assertEquals(html.split("Search result only").length - 1, 1);
});

Deno.test("the graph stores each claim's level; unverified claims have none", async () => {
  const port = new FakeResearch(listing([WARREN]), {
    [WARREN.name]: raw({
      sections: {
        record: section(fact(HERALD, "will not raise taxes, this year or next"), fact(NEVER, "")),
      },
      retrieved_urls: [HERALD],
      opened_pages: [{ url: HERALD, text: HERALD_TEXT }],
    }),
  });
  const p = projectRace(await runRace(QUERY, port), "run-1");
  const facts = p.claims.filter((c) => c.section !== "context");
  assertEquals(facts.map((c) => [c.section, c.check_level]), [
    ["record", "quoted"],
    ["unverified", null],
  ]);
});
