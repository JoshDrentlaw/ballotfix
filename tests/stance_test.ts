import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stanceSupport, strengthOf } from "../src/dossier.ts";
import { renderMeasure, renderRace } from "../src/render.ts";
import { runMeasure, runRace } from "../src/race.ts";
import type { Fact, PriorityResult } from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const c = { name: "Joz Sida", ballot_designation: null, incumbent: false };

/** A fact citing `url`; quoted when its page's text (in `pages`) holds the quote. */
function fact(url: string, source_name: string, evidence_type: string) {
  return {
    statement: "Voted against the tenant protection ordinance.",
    source_name,
    source_url: url,
    author: null,
    published: null,
    evidence_type,
    quote: "Sida voted no on the tenant protection ordinance",
  };
}
const TEXT = "Item 4. Sida voted no on the tenant protection ordinance.";

/** One issue's stance, from facts whose pages were opened (quoted) or only seen. */
async function stanceFrom(
  facts: ReturnType<typeof fact>[],
  opts: { stance?: string; read?: boolean } = {},
): Promise<PriorityResult> {
  const urls = facts.map((f) => f.source_url);
  const race = await runRace(
    QUERY,
    new FakeResearch(listing([c]), {
      "Joz Sida": raw({
        sections: { priority_1: { facts, searched: [], gap_note: null } },
        stances: { priority_1: { stance: opts.stance ?? "conflicts", basis: "The vote." } },
        retrieved_urls: urls,
        opened_pages: opts.read === false ? [] : urls.map((url) => ({ url, text: TEXT })),
      }),
    }),
    { priorities: ["protect renters"] },
  );
  return race.candidates[0].priorities![0];
}

Deno.test("one quoted opinion or report is thin; the researcher's stance is kept, marked", async () => {
  const p = await stanceFrom([fact("https://a.example/1", "A Weekly", "opinion")]);
  assertEquals(p.stance, "conflicts");
  assertEquals(p.stance_strength, "thin");
  const r = await stanceFrom([fact("https://a.example/1", "A Weekly", "reported")]);
  assertEquals(r.stance_strength, "thin");
});

Deno.test("two outlets, or one primary record, both quoted, make a stance full", async () => {
  const two = await stanceFrom([
    fact("https://a.example/1", "A Weekly", "reported"),
    fact("https://b.example/1", "B Daily", "reported"),
  ]);
  assertEquals(two.stance_strength, "full");
  const primary = await stanceFrom([fact("https://city.example/m", "Minutes", "primary_record")]);
  assertEquals(primary.stance_strength, "full");
  // "mixed" follows the same rule.
  const mixed = await stanceFrom([fact("https://a.example/1", "A Weekly", "reported")], {
    stance: "mixed",
  });
  assertEquals(mixed.stance_strength, "thin");
});

Deno.test("only quoted facts count: same outlet twice, or unread pages, stay thin", async () => {
  const same = await stanceFrom([
    fact("https://a.example/1", "A Weekly", "reported"),
    fact("https://a.example/2", "A weekly", "reported"),
  ]);
  assertEquals(same.stance_strength, "thin");
  // A primary record seen only as a search result isn't quoted.
  const seen = await stanceFrom(
    [fact("https://city.example/m", "Minutes", "primary_record")],
    { read: false },
  );
  assertEquals(seen.stance, "conflicts");
  assertEquals(seen.stance_strength, "thin");
  // Unsourced facts never count, so this is unclear, with no strength.
  const unsourced = await stanceFrom([fact("https://a.example/1", "Blog", "unsourced")]);
  assertEquals(unsourced.stance, "unclear");
  assertEquals(unsourced.stance_strength, undefined);
});

Deno.test("a merged fact's other sources count as their outlets", () => {
  const f = (source_name: string): Fact => ({
    statement: "s",
    source_name,
    source_url: `https://${source_name}.example/`,
    author: null,
    published: null,
    evidence_type: "reported",
    check: { level: "quoted", opened: true, read: true },
  });
  const merged = { facts: [{ ...f("a"), also: [f("b")] }], searched: [], gap_note: null };
  assertEquals(stanceSupport(merged), { facts: 2, quoted: 2, outlets: 2, primary: 0 });
  assertEquals(strengthOf(stanceSupport(merged)), "full");
});

Deno.test("the page marks thin stances, lists them after full ones, and notes older runs", async () => {
  const b = { name: "Pat Example", ballot_designation: null, incumbent: false };
  const one = fact("https://a.example/1", "A Weekly", "reported");
  const primary = fact("https://city.example/m", "Minutes", "primary_record");
  const race = await runRace(
    QUERY,
    new FakeResearch(listing([c, b]), {
      "Joz Sida": raw({
        sections: {
          priority_1: { facts: [one], searched: [], gap_note: null },
          priority_2: { facts: [primary], searched: [], gap_note: null },
        },
        stances: {
          priority_1: { stance: "conflicts", basis: "One report." },
          priority_2: { stance: "aligns", basis: "The vote." },
        },
        retrieved_urls: [one.source_url, primary.source_url],
        opened_pages: [one, primary].map((f) => ({ url: f.source_url, text: TEXT })),
      }),
    }),
    { priorities: ["protect renters", "keep taxes low"] },
  );
  const html = renderRace(race);
  const card = html.slice(
    html.indexOf('<ul class="cards">'),
    html.indexOf("</ul>", html.indexOf('<ul class="cards">')),
  );
  // The full "aligns" comes before the thin "conflicts", which carries its count.
  assertStringIncludes(card, "Matches your view:</strong> keep taxes low");
  assertStringIncludes(card, "Conflicts with your view, thin:</strong> protect renters (1 fact)");
  assert(card.indexOf("Matches") < card.indexOf("Conflicts"));
  assertStringIncludes(html, "Conflicts with your view, thin.</strong>");
  assertStringIncludes(html, "is from one outlet and isn&#39;t a primary record");
  assertStringIncludes(html, ">Conflicts, thin</a>");
  assert(!html.includes("before that threshold existed"));

  // A run saved before the threshold reads as it did, with a note.
  const old = structuredClone(race);
  for (const p of old.candidates[0].priorities!) delete p.stance_strength;
  const before = renderRace(old);
  assertStringIncludes(before, "before that threshold existed");
  assert(!before.includes(", thin"));
});

Deno.test("a measure's stance follows the same threshold", async () => {
  const one = {
    ...fact("https://a.example/1", "A Weekly", "reported"),
    quote: "Measure X would raise the sales tax by half a cent",
  };
  const d = await runMeasure(
    {
      label: "Measure X",
      jurisdiction: "City",
      question: "",
      state: "CA",
      electionDate: "2026-11-03",
    },
    new FakeResearch(listing([]), {}, {
      "Measure X": rawMeasure({
        sections: { priority_1: { facts: [one], searched: [], gap_note: null } },
        stances: { priority_1: { stance: "conflicts", basis: "Raises a tax." } },
        retrieved_urls: [one.source_url],
        opened_pages: [{
          url: one.source_url,
          text: "Measure X would raise the sales tax by half a cent.",
        }],
      }),
    }),
    { priorities: ["oppose new taxes"] },
  );
  assertEquals(d.priorities![0].stance_strength, "thin");
  assertStringIncludes(renderMeasure(d), "A yes vote conflicts with your view, thin");
});
