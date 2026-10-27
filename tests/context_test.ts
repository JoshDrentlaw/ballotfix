/**
 * The context step: which names are found and sent, how the cap is shared,
 * which notes stand, how they render and index, and how the job runner calls
 * it once per finished run, after the merge step.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkNotes,
  contextForMeasure,
  contextForRace,
  findNames,
  MAX_CONTEXT_NAMES,
} from "../src/context.ts";
import { organizationRef, personRef, projectRace } from "../src/knowledge.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { renderMeasure, renderRace } from "../src/render.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { KnowledgeBase } from "../src/web/kb.ts";
import { openStores } from "../src/web/store.ts";
import type {
  BallotCandidate,
  ContextRequest,
  ContextWriter,
  MeasureQuery,
  RaceDossier,
  RawContextNote,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true },
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
];

const HERALD = "https://www.fontanaherald.com/news/endorsements";
const PE = "https://www.pe.com/2026/fontana-endorsements";
const NEVER = "https://example.com/never-fetched";
const SOS = "https://cal-access.sos.ca.gov/committee/123";

function fact(statement: string, source_url = HERALD, extra = {}): RawFact {
  return {
    statement,
    source_name: "Fontana Herald News",
    source_url,
    author: null,
    published: "2026-09-01",
    evidence_type: "reported",
    ...extra,
  };
}

const section = (...facts: RawFact[]) => ({ facts, searched: [], gap_note: null });

/** Both candidates are endorsed by the same PAC; Warren also by a union local. */
async function race(): Promise<RaceDossier> {
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: {
        endorsements: section(
          fact("Endorsed by Inland Builders PAC and SEIU Local 2015."),
          fact("Mayor Warren was endorsed by Hidden Name Group, per a blog.", NEVER),
        ),
      },
      retrieved_urls: [HERALD],
    }),
    "Joz Sida": raw({
      sections: { endorsements: section(fact("Inland Builders PAC endorsed Joz Sida.", PE)) },
      retrieved_urls: [PE],
    }),
  });
  return await runRace(QUERY, port, { candidates: CANDS });
}

/** Records each request and answers from a table keyed by name. */
function writer(
  table: Record<string, Partial<RawContextNote>>,
  retrieved: string[] = [SOS],
): ContextWriter & { requests: ContextRequest[] } {
  const requests: ContextRequest[] = [];
  return {
    requests,
    describeNames: (req) => {
      requests.push(req);
      return Promise.resolve({
        notes: req.names.flatMap((n) =>
          table[n.name]
            ? [{
              id: n.id,
              kind: "organization",
              note: "",
              source_name: "California Secretary of State",
              source_url: SOS,
              author: null,
              published: null,
              ...table[n.name],
            }]
            : []
        ),
        retrieved_urls: retrieved,
        model: "fake",
      });
    },
  };
}

const PAC_NOTE = { note: "A political action committee formed by Inland Empire home builders." };

Deno.test("names are runs of capitalized words, minus titles, openers, candidates, and generic words", () => {
  const ex = new Set(["acquanetta warren", "acquanetta", "warren", "fontana"]);
  assertEquals(
    findNames(
      "Mayor Warren voted with Councilmember John Roberts to approve the Sierra Lakes warehouse proposed by Hillwood Investment Properties.",
      ex,
    ),
    ["John Roberts", "Sierra Lakes", "Hillwood Investment Properties"],
  );
  assertEquals(
    findNames("Received $25,000 from SEIU Local 2015 and the California Apartment Association."),
    ["SEIU Local 2015", "California Apartment Association"],
  );
  assertEquals(findNames("The Fontana City Council approved Measure X in June 2025.", ex), []);
  assertEquals(
    findNames("Sued by the U.S. Department of Justice, per the Press-Enterprise.", ex),
    ["U.S. Department of Justice", "Press-Enterprise"],
  );
  assertEquals(findNames("Friends of Fontana Parks backed Warren's plan.", ex), [
    "Friends of Fontana Parks",
  ]);
});

Deno.test("one call per race, verified facts only, without saying whose facts they are", async () => {
  const w = writer({ "Inland Builders PAC": PAC_NOTE });
  const out = await contextForRace(await race(), w);
  assertEquals(w.requests.length, 1);
  const req = w.requests[0];
  assertEquals(req.place, "Fontana, CA");
  assertEquals(req.names.map((n) => n.name), ["Inland Builders PAC", "SEIU Local 2015"]);
  // The unverified fact's name is never sent, and no candidate name appears anywhere but
  // inside a quoted statement.
  const sent = JSON.stringify(req);
  assert(!sent.includes("Hidden Name Group"));
  assert(!req.names.some((n) => /Warren|Sida/.test(n.name)));
  assert(!("candidate" in req.names[0]));
  // The PAC is named for both candidates and gets one note, the same for both.
  assertEquals(out.sent, 2);
  assertEquals(out.shown, 1);
  assertEquals(out.dossier.context!.not_described, ["SEIU Local 2015"]);
  assertEquals(out.dossier.context!.not_looked_up, []);
});

Deno.test("a race with no names makes no call but records that the step ran", async () => {
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: { record: section(fact("Voted for the 2025 budget.")) },
      retrieved_urls: [HERALD],
    }),
  });
  const w = writer({});
  const out = await contextForRace(await runRace(QUERY, port, { candidates: CANDS }), w);
  assertEquals(w.requests.length, 0);
  assertEquals(out.sent, 0);
  assertEquals(out.dossier.context, {
    notes: [],
    not_looked_up: [],
    not_described: [],
    model: null,
  });
});

Deno.test("over the cap, every candidate gets the same share, and the rest are listed", async () => {
  // Warren's facts name 40 organizations, Sida's 5; ballot order puts Warren first.
  const orgs = (prefix: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) => `${prefix} Group ${String.fromCharCode(65 + (i % 26))}${i}`,
    );
  const many = orgs("Alpha", 40), few = orgs("Beta", 5);
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: { endorsements: section(...many.map((o) => fact(`Endorsed by ${o}.`))) },
      retrieved_urls: [HERALD],
    }),
    "Joz Sida": raw({
      sections: { endorsements: section(...few.map((o) => fact(`Endorsed by ${o}.`))) },
      retrieved_urls: [HERALD],
    }),
  });
  const r = await runRace(QUERY, port, { candidates: CANDS });
  const w = writer({});
  const out = await contextForRace(r, w);
  const sent = w.requests[0].names.map((n) => n.name);
  assertEquals(sent.length, MAX_CONTEXT_NAMES);
  // All of Sida's five go, and Warren gets the rest of the cap.
  for (const o of few) assert(sent.includes(o));
  assertEquals(out.skipped, 45 - MAX_CONTEXT_NAMES);
  // Reversed ballot order sends the same set.
  const flipped = { ...r, candidates: [...r.candidates].reverse() };
  const w2 = writer({});
  await contextForRace(flipped, w2);
  assertEquals(new Set(w2.requests[0].names.map((n) => n.name)), new Set(sent));
  // Nothing left out is silent: the page lists every name not looked up.
  const page = renderRace(out.dossier);
  for (const o of out.dossier.context!.not_looked_up) assertStringIncludes(page, o);
  assertStringIncludes(page, `at most ${MAX_CONTEXT_NAMES} names`);
});

Deno.test("a measure's case for and case against get equal shares", async () => {
  const m: MeasureQuery = {
    label: "Measure X",
    jurisdiction: "City of Fontana",
    question: "",
    state: "CA",
    electionDate: "2026-11-03",
  };
  const names = (side: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${side} Committee ${String.fromCharCode(65 + i)}`);
  const port = new FakeResearch(listing([]), {}, {
    "Measure X": rawMeasure({
      sections: {
        case_for: section(...names("Yes", 25).map((o) => fact(`Supported by ${o}.`))),
        case_against: section(...names("No", 25).map((o) => fact(`Opposed by ${o}.`))),
      },
      retrieved_urls: [HERALD],
    }),
  });
  const w = writer({});
  await contextForMeasure(await runMeasure(m, port), w);
  const sent = w.requests[0].names.map((n) => n.name);
  assertEquals(sent.filter((s) => s.startsWith("Yes")).length, MAX_CONTEXT_NAMES / 2);
  assertEquals(sent.filter((s) => s.startsWith("No")).length, MAX_CONTEXT_NAMES / 2);
  assertEquals(w.requests[0].place, "City of Fontana, CA");
});

Deno.test("a note stands only on a retrieved page, in plain words, for a name that was sent", () => {
  const sent = ["A PAC", "B Union", "C Group", "D Firm", "E Person", "F Co", "G Org"].map((
    name,
    i,
  ) => ({ id: `n${i + 1}`, name, mentions: [] }));
  const base = {
    kind: "organization",
    note: "A trade association.",
    source_name: "SOS",
    source_url: SOS,
    author: null,
    published: null,
  };
  const { notes, not_described } = checkNotes(sent, [
    { ...base, id: "n1" },
    { ...base, id: "n1", note: "A later answer for the same id is ignored." },
    { ...base, id: "n2", source_url: NEVER },
    { ...base, id: "n3", note: "A controversial developer." },
    { ...base, id: "n4", note: "x".repeat(400) },
    { ...base, id: "n5", kind: "skip", note: "" },
    { ...base, id: "n6", kind: "unknown", note: "" },
    { ...base, id: "n99", note: "Not a name that was sent." },
    { ...base, id: "n7", source_url: "javascript:alert(1)" },
  ], [SOS]);
  assertEquals(notes.map((n) => [n.name, n.note, n.verified]), [
    ["A PAC", "A trade association.", true],
    ["B Union", "A trade association.", false],
  ]);
  // Skipped (no note needed) is not a gap; everything else that can't be shown is listed.
  assertEquals(not_described, ["C Group", "D Firm", "F Co", "G Org"]);
});

Deno.test("a missing answer is listed as not described, never dropped", () => {
  const sent = [{ id: "n1", name: "A PAC", mentions: [] }];
  assertEquals(checkNotes(sent, [], []), { notes: [], not_described: ["A PAC"] });
});

Deno.test("a verified note renders collapsed next to the name, escaped; an unverified one doesn't", async () => {
  const w = writer({
    "Inland Builders PAC": { note: "A <b>PAC</b> of home builders.", published: "2026-01" },
    "SEIU Local 2015": { note: "A union of home care workers.", source_url: NEVER },
  });
  const { dossier } = await contextForRace(await race(), w);
  const page = renderRace(dossier);
  assertStringIncludes(
    page,
    `<span class="named">Inland Builders PAC</span><details class="ctx"><summary aria-label="What is Inland Builders PAC?">what?</summary>`,
  );
  assertStringIncludes(page, "A &lt;b&gt;PAC&lt;/b&gt; of home builders.");
  assert(!page.includes("<b>PAC</b>"));
  // Shown for both candidates, the same note.
  assertEquals(page.split(`<span class="named">Inland Builders PAC</span>`).length - 1, 2);
  // The unretrieved one is only in the collapsed list, never next to the name.
  assert(!page.includes(`<span class="named">SEIU Local 2015</span>`));
  assertStringIncludes(page, "1 note not shown because the cited page was never retrieved");
  // No details inside a paragraph: the statement becomes a div.
  assert(!/<p>[^<]*<span class="named">/.test(page));
});

Deno.test("pages from before the step render as they did", async () => {
  const page = renderRace(await race());
  assert(!page.includes("Names in these facts"));
  assert(!page.includes(`class="named"`));
});

Deno.test("named entities join the graph, scoped by place, linked from every claim naming them", async () => {
  const w = writer({
    "Inland Builders PAC": PAC_NOTE,
    "SEIU Local 2015": { note: "A union local." },
  });
  const { dossier } = await contextForRace(await race(), w);
  const p = projectRace(dossier, "run-1");
  const pac = organizationRef("CA", "Fontana", "Inland Builders PAC");
  assert(p.entities.some((e) => e.key === pac.key && e.kind === "organization"));
  // Elsewhere, the same name is a different entity.
  assert(pac.key !== organizationRef("CA", "Rialto", "Inland Builders PAC").key);
  const naming = p.claims.filter((c) => c.named.includes(pac.key));
  assertEquals(
    new Set(naming.map((c) => c.subject)),
    new Set(CANDS.map((c) => personRef("CA", "Fontana", c.name).key)),
  );
  const note = p.claims.find((c) => c.subject === pac.key)!;
  assertEquals(note.section, "context");
  assertEquals(note.verified, true);
  assertEquals(note.citations[0].url, SOS);

  // Stored: the PAC's page in the graph shows its note and both candidates' claims.
  const s = await openStores(await Deno.makeTempDir());
  const kb = new KnowledgeBase(s.db);
  await s.runs.save({
    id: "run-1",
    query: QUERY,
    candidates: CANDS,
    candidate_source: null,
    choice_id: "run-1",
    status: "done",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    race: dossier,
  });
  const e = kb.entity(pac.key)!;
  const claims = kb.claimsAbout(e.id);
  assertEquals(claims.filter((c) => c.role === "subject").length, 1);
  assertEquals(claims.filter((c) => c.role === "named").length, 2);
  s.db.close();
});

Deno.test("the job runner adds notes after merging, to the merged run, and a failure leaves it done", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: {
        endorsements: section(
          fact("Endorsed by Inland Builders PAC."),
          fact("Inland Builders PAC endorsed her.", PE, { source_name: "Press-Enterprise" }),
        ),
      },
      retrieved_urls: [HERALD, PE],
    }),
  });
  const order: string[] = [];
  let fail = false;
  const logs: string[] = [];
  const jobs = new JobRunner(s.runs, () => port, {
    log: (m) => logs.push(m),
    makeMerger: () => ({
      groupDuplicates: (blocks) => {
        order.push("merge");
        return Promise.resolve([blocks[0].facts.map((f) => f.id)]);
      },
    }),
    makeContextWriter: () => ({
      describeNames: async (req) => {
        order.push(`context ${(await s.runs.list())[0]?.status}`);
        if (fail) throw new Error("max_tokens");
        return writer({ "Inland Builders PAC": PAC_NOTE }).describeNames(req);
      },
    }),
  });
  const run = await jobs.submit(QUERY, CANDS);
  await jobs.idle();
  assertEquals(order, ["merge", "context done"]);
  const saved = (await s.runs.get(run.id))!;
  assertEquals(saved.status, "done");
  const facts = saved.race!.candidates[0].sections.endorsements.facts;
  assertEquals(facts.length, 1);
  assertEquals(facts[0].also?.length, 1);
  assertEquals(saved.race!.context?.notes.length, 1);
  assert(logs.some((l) => l.includes("wrote 1 context note(s) for 1 names")));

  fail = true;
  const second = await jobs.submit(QUERY, CANDS);
  await jobs.idle();
  const kept = (await s.runs.get(second.id))!;
  assertEquals(kept.status, "done");
  assertEquals(kept.race!.context, undefined);
  // Merged all the same.
  assertEquals(kept.race!.candidates[0].sections.endorsements.facts.length, 1);
  assert(logs.some((l) => l.includes("context notes failed: max_tokens")));
  s.db.close();
});

Deno.test("a measure's notes render on its page", async () => {
  const m: MeasureQuery = {
    label: "Measure X",
    jurisdiction: "City of Fontana",
    question: "",
    state: "CA",
    electionDate: "2026-11-03",
  };
  const port = new FakeResearch(listing([]), {}, {
    "Measure X": rawMeasure({
      sections: {
        case_for: section(fact("Supported by Friends of Fontana Parks.")),
        case_against: section(fact("Opposed by the Fontana Taxpayers Association.")),
      },
      retrieved_urls: [HERALD],
    }),
  });
  const w = writer({
    "Friends of Fontana Parks": { note: "A committee formed to support Measure X." },
    "Fontana Taxpayers Association": { note: "A committee formed to oppose Measure X." },
  });
  const { dossier } = await contextForMeasure(await runMeasure(m, port), w);
  const page = renderMeasure(dossier);
  // The period after a name stays with it, not alone on a line under an open note.
  assertStringIncludes(page, `<span class="named">Friends of Fontana Parks.</span><details`);
  assertStringIncludes(page, `<span class="named">Fontana Taxpayers Association.</span><details`);
  assert(!page.includes("</details>.</div>"));
});
