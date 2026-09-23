import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  assembleCandidate,
  failedCandidate,
  incumbencyNote,
  normalizeUrl,
} from "../src/dossier.ts";
import { SECTION_IDS } from "../src/template.ts";
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
