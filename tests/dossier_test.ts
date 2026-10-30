import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  assembleCandidate,
  assembleMeasure,
  failedCandidate,
  incumbencyNote,
  measuresOf,
  normalizeUrl,
} from "../src/dossier.ts";
import { MEASURE_SECTION_IDS, SECTION_IDS } from "../src/template.ts";
import { listing, raw } from "./fakes.ts";

const WARREN = { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true };
const SIDA = { name: "Joz Sida", ballot_designation: null, incumbent: false };

function fact(url: string, extra: Record<string, unknown> = {}) {
  return {
    statement: "Did a thing.",
    source_name: "Paper",
    source_url: url,
    author: null,
    published: "2022-04-19",
    evidence_type: "reported",
    ...extra,
  };
}

Deno.test("every template section is present, in order, even when research returned none", () => {
  const d = assembleCandidate(SIDA, raw());
  assertEquals(Object.keys(d.sections), [...SECTION_IDS]);
  for (const id of SECTION_IDS) assert(d.sections[id].gap_note, `${id} has no gap note`);
});

Deno.test("a dossier keeps the searches and fetches its research made", () => {
  const d = assembleCandidate(SIDA, { ...raw(), effort: { searches: 12, fetches: 7 } });
  assertEquals(d.effort, { searches: 12, fetches: 7 });
  assert(!("effort" in assembleCandidate(SIDA, raw())));
  const bad = { searches: Number.NaN, fetches: -1 } as unknown as {
    searches: number;
    fetches: number;
  };
  assert(!("effort" in assembleCandidate(SIDA, { ...raw(), effort: bad })));
});

Deno.test("unknown section keys from the model are dropped, not rendered", () => {
  const d = assembleCandidate(
    SIDA,
    raw({
      sections: { verdict: { facts: [fact("https://a.com/x")], searched: [], gap_note: null } },
      retrieved_urls: ["https://a.com/x"],
    }),
  );
  assertEquals(Object.keys(d.sections), [...SECTION_IDS]);
});

Deno.test("facts citing a page the session never retrieved move to unverified", () => {
  const d = assembleCandidate(
    WARREN,
    raw({
      sections: {
        criticisms: {
          facts: [fact("https://oag.ca.gov/news/a"), fact("https://made-up.example/b")],
          searched: ["CA AG press releases"],
          gap_note: null,
        },
      },
      retrieved_urls: ["https://www.oag.ca.gov/news/a/#top"],
    }),
  );
  assertEquals(d.sections.criticisms.facts.map((f) => f.source_url), ["https://oag.ca.gov/news/a"]);
  assertEquals(d.unverified.map((f) => f.source_url), ["https://made-up.example/b"]);
});

Deno.test("non-http URLs and empty statements are discarded outright", () => {
  const d = assembleCandidate(
    SIDA,
    raw({
      sections: {
        background: {
          facts: [fact("javascript:alert(1)"), fact("https://a.com/ok", { statement: "  " })],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: ["https://a.com/ok"],
    }),
  );
  assertEquals(d.sections.background.facts.length, 0);
  assertEquals(d.unverified.length, 0);
});

Deno.test("unknown evidence types collapse to unsourced", () => {
  const d = assembleCandidate(
    SIDA,
    raw({
      sections: {
        platform: {
          facts: [fact("https://a.com/p", { evidence_type: "verified_true" })],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: ["https://a.com/p"],
    }),
  );
  assertEquals(d.sections.platform.facts[0].evidence_type, "unsourced");
});

Deno.test("non-incumbent gets an explicit note in the record section", () => {
  const d = assembleCandidate(SIDA, raw());
  assertMatch(d.sections.record.gap_note!, /Not the incumbent/);
});

Deno.test("a failed candidate still has the full template, each section saying it failed", () => {
  const d = failedCandidate(SIDA, "boom");
  assertEquals(d.status, "failed");
  assertEquals(Object.keys(d.sections), [...SECTION_IDS]);
  for (const id of SECTION_IDS) assertMatch(d.sections[id].gap_note!, /failed/);
});

Deno.test("normalizeUrl matches across scheme, www, fragment, trailing slash, utm params", () => {
  assertEquals(
    normalizeUrl("http://WWW.Example.com/a/?utm_source=x&id=2#frag"),
    normalizeUrl("https://example.com/a?id=2"),
  );
  assertEquals(normalizeUrl("ftp://example.com/a"), null);
  assertEquals(normalizeUrl("not a url"), null);
});

Deno.test("incumbency note appears only when someone holds the office", () => {
  assert(incumbencyNote(listing([WARREN, SIDA]))!.startsWith("Acquanetta Warren holds"));
  assertEquals(incumbencyNote(listing([SIDA])), null);
});

Deno.test("a measure gets the full template, the provenance check, and the voter's issues", () => {
  const q = {
    label: "Measure X",
    jurisdiction: "City of Fontana",
    question: "",
    state: "CA",
    electionDate: "2026-11-03",
  };
  const d = assembleMeasure(
    q,
    {
      sections: {
        effect: { facts: [fact("https://a.example/x")], searched: [], gap_note: null },
        priority_1: { facts: [fact("https://never.example/y")], searched: [], gap_note: null },
      },
      official_title: null,
      identity_note: null,
      gaps: [],
      retrieved_urls: ["https://a.example/x"],
      model: "fake",
    },
    ["parks"],
    new Date("2026-10-25T00:00:00Z"),
  );
  assertEquals(Object.keys(d.sections), [...MEASURE_SECTION_IDS]);
  assertEquals(d.sections.effect.facts.length, 1);
  assertEquals(
    d.sections.case_against.gap_note,
    "This run found nothing it could source for this section.",
  );
  assertEquals(d.priorities.map((p) => p.issue), ["parks"]);
  assertEquals(d.priorities[0].result.facts, []);
  assertEquals(d.unverified.map((f) => f.source_url), ["https://never.example/y"]);
  assert(d.standing_gaps.length > 0);
});

Deno.test("what a yes and a no vote mean get the provenance check, each on its own", () => {
  const d = assembleMeasure(
    {
      label: "Measure X",
      jurisdiction: "City",
      question: "",
      state: "CA",
      electionDate: "2026-11-03",
    },
    {
      sections: {},
      vote_means: {
        yes: fact("https://a.example/x", { statement: " A YES vote means the tax is adopted. " }),
        no: fact("https://never.example/y", { statement: "A NO vote means it is not." }),
      },
      official_title: null,
      identity_note: null,
      gaps: [],
      retrieved_urls: ["https://a.example/x"],
      model: "fake",
    },
    [],
    new Date("2026-10-25T00:00:00Z"),
  );
  assertEquals(d.vote_means?.yes?.statement, "A YES vote means the tax is adopted.");
  assertEquals(d.vote_means?.no, null);
  assertEquals(d.unverified.map((f) => f.statement), ["A NO vote means it is not."]);
});

Deno.test("every candidate gets one result per issue, in the voter's order", () => {
  const d = assembleCandidate(SIDA, {
    sections: {},
    identity_note: null,
    gaps: [],
    retrieved_urls: [],
    model: "fake",
  }, ["b", "a"]);
  assertEquals(d.priorities!.map((p) => p.issue), ["b", "a"]);
  assert(d.priorities!.every((p) => p.result.gap_note));
  assertEquals(failedCandidate(SIDA, "x", ["b"]).priorities!.length, 1);
});

Deno.test("measuresOf reads older string-only readings as measures", () => {
  const m = measuresOf({
    election_date: null,
    state: null,
    county: null,
    contests: [],
    measures: ["Measure X: parks"],
    notes: null,
    model: "old",
  });
  assertEquals(m, [{
    kind: "measure",
    label: "Measure X: parks",
    jurisdiction: "",
    question: "",
    person: "",
  }]);
});

Deno.test("a retention question's note explains there is no opponent", () => {
  const judge = { name: "Pat Judge", ballot_designation: null, incumbent: true };
  const note = incumbencyNote({
    candidates: [judge],
    source_name: "x",
    source_url: null,
    order_basis: "official_ballot_order",
    notes: null,
    contest_kind: "retention",
    retrieved_urls: [],
  });
  assertStringIncludes(note!, "yes/no retention question");
  assert(!note!.includes("Challengers"));
});
