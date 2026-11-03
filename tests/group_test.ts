import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runRace } from "../src/race.ts";
import { byPage, renderRace } from "../src/render.ts";
import type { BallotCandidate, Fact, RawFact } from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw } from "./fakes.ts";

const GUIDE = "https://voterguide.sos.ca.gov/propositions/37/arguments";
const NEWS = "https://calmatters.org/housing/prop-37";

function fact(statement: string, extra: Partial<Fact> = {}): Fact {
  return {
    statement,
    source_name: "Official Voter Guide",
    source_url: GUIDE,
    author: null,
    published: "2026-08-01",
    evidence_type: "primary_record",
    ...extra,
  };
}

const names = (items: (Fact | Fact[])[]) =>
  items.map((x) => Array.isArray(x) ? x.map((f) => f.statement) : x.statement);

Deno.test("facts from one page are gathered where its newest fact falls, in order inside", () => {
  const ordered = [
    fact("A"),
    fact("B", { source_name: "CalMatters", source_url: NEWS }),
    fact("C", { source_url: `${GUIDE}/?utm_source=x` }), // the same page, as the provenance check reads it
    fact("D", { source_name: "CalMatters", source_url: NEWS }),
    fact("E", { source_name: "SPUR", source_url: "https://spur.org/prop-37" }),
  ];
  assertEquals(names(byPage(ordered, () => false)), [["A", "C"], ["B", "D"], "E"]);
});

Deno.test("a page's facts are gathered whatever byline each gives; another outlet's, merged, and referenced facts stand alone", () => {
  const ordered = [
    fact("A"),
    fact("B", { author: "Jane Doe" }), // its byline worded differently: still the page's
    fact("C", { source_name: "Voter Guide (argument in favor)" }), // another outlet named
    fact("D", { also: [fact("D2", { source_name: "KQED", source_url: "https://kqed.org/p37" })] }),
    fact("E"),
    fact("F"),
  ];
  assertEquals(
    names(byPage(ordered, (f) => f.statement === "F")),
    [["A", "B", "E"], "C", "D", "F"],
  );
});

Deno.test("a section's facts from one page show its source line once, each fact keeping its own tags", async () => {
  const CANDS: BallotCandidate[] = [{
    name: "Joz Sida",
    ballot_designation: null,
    incumbent: false,
  }];
  const f = (statement: string, extra: Partial<RawFact> = {}): RawFact => ({
    statement,
    source_name: "Fontana Herald News",
    source_url: "https://www.fontanaherald.com/news/forum",
    author: "Sam Reporter",
    published: "2026-10-01",
    evidence_type: "reported",
    ...extra,
  });
  const port = new FakeResearch(listing(CANDS), {
    "Joz Sida": raw({
      sections: {
        platform: {
          facts: [
            f("Joz Sida wants more parks."),
            f("Joz Sida said rents are too high.", { evidence_type: "opinion" }),
            f("Joz Sida backs a library.", {
              source_name: "Inland Daily",
              source_url: "https://inlanddaily.example/sida",
            }),
          ],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: [
        "https://www.fontanaherald.com/news/forum",
        "https://inlanddaily.example/sida",
      ],
    }),
  });
  const page = renderRace(await runRace(QUERY, port, { candidates: CANDS }));
  assertStringIncludes(page, "2 facts from this page");
  // The page's source line is said once, for both of its facts.
  assertEquals(page.split(">Fontana Herald News</a>").length - 1, 1);
  for (const s of ["more parks", "rents are too high", "backs a library"]) {
    assertStringIncludes(page, s);
  }
  // Each fact in the group keeps its own evidence type.
  const group = page.slice(page.indexOf('class="fact page-group"'));
  const inGroup = group.slice(0, group.indexOf("</ul>"));
  assertStringIncludes(inGroup, "ev-reported");
  assertStringIncludes(inGroup, "ev-opinion");
  // The other page's fact is its own item, with its own source line.
  assert(page.includes("Inland Daily"));
  assertEquals(page.split('class="fact page-group"').length - 1, 1);
});

Deno.test("a byline the facts give differently is said on each fact, never on the page's line", async () => {
  const CANDS: BallotCandidate[] = [{
    name: "Joz Sida",
    ballot_designation: null,
    incumbent: false,
  }];
  const PAGE = "https://www.fontanaherald.com/news/forum";
  const f = (statement: string, author: string): RawFact => ({
    statement,
    source_name: "Fontana Herald News",
    source_url: PAGE,
    author,
    published: "2026-10-01",
    evidence_type: "reported",
  });
  const port = new FakeResearch(listing(CANDS), {
    "Joz Sida": raw({
      sections: {
        platform: {
          facts: [
            f("Joz Sida wants parks.", "Sam Reporter"),
            f("Joz Sida wants trees.", "S. Reporter"),
          ],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: [PAGE],
    }),
  });
  const page = renderRace(await runRace(QUERY, port, { candidates: CANDS }));
  const group = page.slice(page.indexOf('class="fact page-group"'));
  const line = group.slice(0, group.indexOf("</p>"));
  // The date both give is on the line; the bylines they word differently are not.
  assertStringIncludes(line, "Oct 1, 2026");
  assertEquals(line.includes("Reporter"), false);
  assertStringIncludes(group, "by Sam Reporter");
  assertStringIncludes(group, "by S. Reporter");
});
