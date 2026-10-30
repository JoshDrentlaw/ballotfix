/**
 * The campaign finance step: what is asked and how the cap is shared, which
 * rows stand, how contributors are matched (and when they are kept apart),
 * how it renders and indexes, and how the job runner runs it once per
 * finished run, after the context step.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { contextForMeasure, contextForRace } from "../src/context.ts";
import {
  checkFinance,
  financeForMeasure,
  financeForRace,
  MAX_CONTRIBUTIONS_PER_SUBJECT,
  MAX_FIELD_CHARS,
  MAX_FINANCE_CONTRIBUTIONS,
  MAX_NOTE_CHARS,
  measureConnections,
  NOTHING_FOUND,
  NOTHING_OPENED,
  raceConnections,
  raceFinanceFailed,
  shareFor,
} from "../src/finance.ts";
import {
  contributorRef,
  jurisdictionKey,
  organizationRef,
  personRef,
  projectRace,
  sideRef,
} from "../src/knowledge.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { renderMeasure, renderRace } from "../src/render.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { openStores } from "../src/web/store.ts";
import type {
  BallotCandidate,
  ContextWriter,
  FinanceRequest,
  FinanceResearcher,
  MeasureQuery,
  RaceDossier,
  RawContribution,
  RawFact,
  RawFinanceSubject,
} from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true },
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
  { name: "Third Person", ballot_designation: null, incumbent: false },
];

const HERALD = "https://www.fontanaherald.com/news/endorsements";
const FILING = "https://public.netfile.com/pub2/filing/123.pdf";
const FILING_2 = "https://public.netfile.com/pub2/filing/456.pdf";
const NEVER = "https://example.com/never-fetched";
const SOS = "https://cal-access.sos.ca.gov/committee/123";

function fact(statement: string, source_url = HERALD): RawFact {
  return {
    statement,
    source_name: "Fontana Herald News",
    source_url,
    author: null,
    published: "2026-09-01",
    evidence_type: "reported",
  };
}

const section = (...facts: RawFact[]) => ({ facts, searched: [], gap_note: null });

function gift(contributor: string, amount: string, extra: Partial<RawContribution> = {}) {
  return {
    filer: "Committee",
    contributor,
    contributor_type: "organization",
    occupation: "",
    employer: "",
    amount,
    date: "09/14/2026",
    filing_period: "07/01/2026 - 09/19/2026",
    filing: "Form 460, Schedule A",
    source_name: "City of Fontana, NetFile",
    source_url: FILING,
    ...extra,
  } satisfies RawContribution;
}

function subject(id: string, contributions: RawContribution[], extra = {}): RawFinanceSubject {
  return {
    id,
    committees: [],
    searched: ["city clerk portal"],
    gap_note: "",
    not_listed: "",
    totals: [],
    contributions,
    ...extra,
  };
}

/** Answers from a table keyed by subject name (or role, for a measure), recording each request. */
function researcher(
  table: Record<string, RawContribution[]>,
  retrieved = [FILING, FILING_2],
): FinanceResearcher & { requests: FinanceRequest[] } {
  const requests: FinanceRequest[] = [];
  return {
    requests,
    findContributions: (req) => {
      requests.push(req);
      return Promise.resolve({
        subjects: req.subjects.flatMap((s) => {
          const rows = table[s.role === "candidate" ? s.name : s.role];
          return rows ? [subject(s.id, rows)] : [];
        }),
        portal_gaps: [],
        retrieved_urls: retrieved,
        model: "fake",
      });
    },
  };
}

/** Warren and Sida are both endorsed by Inland Builders PAC; Third Person's research fails. */
async function race(): Promise<RaceDossier> {
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw({
      sections: { endorsements: section(fact("Endorsed by Inland Builders PAC.")) },
      retrieved_urls: [HERALD],
    }),
    "Joz Sida": raw({
      sections: { endorsements: section(fact("Inland Builders PAC endorsed Joz Sida.")) },
      retrieved_urls: [HERALD],
    }),
    "Third Person": new Error("research failed"),
  });
  return await runRace(QUERY, port, { candidates: CANDS });
}

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

Deno.test("one call per race, every candidate in ballot order with the same share, a failed one too", async () => {
  const r = researcher({});
  const { sent } = await financeForRace(await race(), r);
  assertEquals(sent, 3);
  assertEquals(r.requests.length, 1);
  const req = r.requests[0];
  assertEquals(req.subjects.map((s) => s.name), CANDS.map((c) => c.name));
  assert(req.subjects.every((s) => s.role === "candidate"));
  assertEquals(req.perSubject, shareFor(3));
  assertEquals(req.place, "Fontana, CA");
  assertEquals(req.contest, "Mayor");
});

Deno.test("the share is the same for everyone and never more than the cap allows", () => {
  assertEquals(shareFor(2), MAX_CONTRIBUTIONS_PER_SUBJECT);
  assertEquals(shareFor(12), Math.floor(MAX_FINANCE_CONTRIBUTIONS / 12));
  for (const n of [1, 3, 7, 12, 25]) assert(shareFor(n) * n <= MAX_FINANCE_CONTRIBUTIONS);
  assertEquals(shareFor(0), 0);
});

Deno.test("a row stands only on a retrieved page, kept exactly as the record states it", () => {
  const long = "x".repeat(MAX_FIELD_CHARS + 1);
  const plan = {
    labels: [{ subject: "Acquanetta Warren" }],
    request: {
      subjects: [{ id: "s1", name: "Acquanetta Warren", role: "candidate" as const }],
      perSubject: 5,
    },
  };
  const f = checkFinance(plan, {
    subjects: [subject("s1", [
      gift("  Inland Builders PAC ", "$1,000.00", { contributor_type: "pac?" }),
      gift("Hidden Donor", "$5,000", { source_url: NEVER }),
      gift("No Amount", "TBD"),
      gift("", "$10"),
      gift("Too Long", "$10", { filing: long }),
      // The same row twice counts once, and is counted.
      gift("Inland Builders PAC", "$1,000.00", { contributor_type: "pac?" }),
    ], {
      totals: [
        {
          filer: "W",
          label: "Total contributions received",
          amount: "$18,450.00",
          filing_period: "",
          source_name: "N",
          source_url: FILING,
        },
        {
          filer: "W",
          label: "Unretrieved total",
          amount: "$9",
          filing_period: "",
          source_name: "N",
          source_url: NEVER,
        },
      ],
    })],
    portal_gaps: [{
      portal: "County",
      url: "javascript:alert(1)",
      problem: "weird",
      note: "Needs JS.",
    }],
    retrieved_urls: [FILING],
    model: "fake",
  });
  const s = f.subjects[0];
  assertEquals(s.contributions.length, 1);
  const c = s.contributions[0];
  assertEquals(c.contributor, "Inland Builders PAC");
  assertEquals(c.amount, "$1,000.00");
  assertEquals(c.date, "09/14/2026");
  assertEquals(c.filing_period, "07/01/2026 - 09/19/2026");
  // A type the record doesn't give is unknown, never guessed.
  assertEquals(c.contributor_type, "unknown");
  assertEquals(s.unverified.map((u) => u.contributor), ["Hidden Donor"]);
  assertEquals(s.totals.map((t) => t.label), ["Total contributions received"]);
  // Three bad rows, the repeat, and the unretrieved total.
  assertEquals(s.dropped, 5);
  assertEquals(f.portal_gaps, [{
    portal: "County",
    url: null,
    problem: "other",
    note: "Needs JS.",
  }]);
});

Deno.test("over the share, every candidate keeps the same number, and the rest are listed", async () => {
  const many = (who: string, n: number) =>
    Array.from({ length: n }, (_, i) => gift(`${who} Donor ${i}`, `$${1000 - i}`));
  const share = shareFor(3);
  const r = researcher({
    "Acquanetta Warren": many("W", share + 3),
    "Joz Sida": many("S", share + 1),
  });
  const { dossier, shown, left_out } = await financeForRace(await race(), r);
  const [w, s, t] = dossier.finance!.subjects;
  assertEquals(w.contributions.length, share);
  assertEquals(s.contributions.length, share);
  assertEquals(w.left_out.length, 3);
  assertEquals(s.left_out, [`S Donor ${share}, $${1000 - share}`]);
  assertEquals(shown, share * 2);
  assertEquals(left_out, 4);
  // Nothing found for the third: a gap note, not silence.
  assertEquals(t.contributions, []);
  assertEquals(t.gap_note, NOTHING_FOUND);
  const page = renderRace(dossier);
  assertStringIncludes(page, `each run keeps at most ${share} per candidate`);
  assertStringIncludes(page, "W Donor " + (share + 2));
  assertStringIncludes(page, NOTHING_FOUND.slice(0, 40));
});

Deno.test("a failed call is recorded, and every candidate's money says so", async () => {
  const d = raceFinanceFailed(await race(), "response hit max_tokens before finishing");
  assertEquals(d.finance!.error, "response hit max_tokens before finishing");
  assertEquals(d.finance!.subjects.length, 3);
  assert(d.finance!.subjects.every((s) => s.gap_note?.includes("couldn't be looked up")));
  const page = renderRace(d);
  assertEquals(page.split("couldn&#39;t be looked up in this run.").length - 1, 3);
  assertStringIncludes(page, "The campaign finance lookup failed in this run");
});

Deno.test("contributors match only by kind, place, and exact name; near misses are kept apart and named", async () => {
  const pat = { contributor_type: "individual", occupation: "Engineer", employer: "Acme Co" };
  const r = researcher({
    "Acquanetta Warren": [
      gift("Inland Builders PAC", "$1,000"),
      gift("Smith Development", "$500"),
      gift("Pat Doe", "$250", pat),
      gift("Lee Roe", "$100", { contributor_type: "individual", occupation: "Retired" }),
      gift("Mystery Group", "$100", { contributor_type: "unknown" }),
    ],
    "Joz Sida": [
      gift("INLAND BUILDERS PAC", "$2,500"),
      gift("Smith Development LLC", "$750"),
      gift("Pat Doe", "$100", pat),
      gift("Lee Roe", "$100", { contributor_type: "individual", occupation: "Retired" }),
      gift("Mystery Group", "$100", { contributor_type: "unknown" }),
    ],
  });
  const { dossier } = await financeForRace(await race(), r);
  const [ws] = raceConnections(dossier);
  assertEquals([ws.a, ws.b], ["Acquanetta Warren", "Joz Sida"]);
  // Case doesn't make a different name; the same work makes an individual the same.
  assertEquals(ws.shared.map((x) => x.ref.name).sort(), ["Inland Builders PAC", "Pat Doe"]);
  const possible = ws.possible.map((p) => [...p.a, ...p.b].join(" / ")).sort();
  assertEquals(possible, [
    "Lee Roe / Lee Roe",
    "Mystery Group / Mystery Group",
    "Smith Development / Smith Development LLC",
  ]);
  const page = renderRace(dossier);
  assertStringIncludes(page, "Possibly the same, kept separate");
  // Every pair has its own block in ballot order, whether or not it shares anyone.
  const heads = [
    ...page.matchAll(/<details class="pair"><summary><h5>([^<]+) <span class="desig">/g),
  ].map((m) => m[1]);
  assertEquals(heads, [
    "Acquanetta Warren and Joz Sida",
    "Acquanetta Warren and Third Person",
    "Joz Sida and Third Person",
  ]);
  assertEquals(page.split("No shared contributors or endorsers found.").length - 1, 2);
});

Deno.test("an individual without identifying work is never one entity across rows", () => {
  const base = { contributor: "Lee Roe", contributor_type: "individual" as const };
  const a = contributorRef(
    "CA",
    "Fontana",
    { ...base, occupation: "Retired", employer: null },
    "1",
  );
  const b = contributorRef(
    "CA",
    "Fontana",
    { ...base, occupation: "Retired", employer: null },
    "2",
  );
  assert(a!.key !== b!.key);
  const p = { ...base, occupation: "Engineer", employer: "Acme Co" };
  assertEquals(
    contributorRef("CA", "Fontana", p, "1")!.key,
    contributorRef("CA", "Fontana", p, "2")!.key,
  );
  // Never across places, and never with a named person on name alone.
  assert(
    contributorRef("CA", "Rialto", p, "1")!.key !== contributorRef("CA", "Fontana", p, "1")!.key,
  );
  assert(
    contributorRef("CA", "Fontana", p, "1")!.key !== personRef("CA", "Fontana", "Lee Roe").key,
  );
  // An organization follows the named-entity rule exactly.
  const org = {
    contributor: "Inland Builders PAC",
    contributor_type: "organization" as const,
    occupation: null,
    employer: null,
  };
  assertEquals(
    contributorRef("CA", "City of Fontana", org, "x")!.key,
    organizationRef("CA", "Fontana", "Inland Builders PAC").key,
  );
  assertEquals(contributorRef("CA", "Fontana", { ...org, contributor_type: "unknown" }, "x"), null);
});

Deno.test("a contributor and an endorser are one connection when they are one entity", async () => {
  const { dossier: noted } = await contextForRace(await race(), notes);
  const { dossier } = await financeForRace(
    noted,
    researcher({
      "Acquanetta Warren": [gift("Inland Builders PAC", "$1,000")],
    }),
  );
  const [ws] = raceConnections(dossier);
  const pac = ws.shared.find((x) => x.ref.name === "Inland Builders PAC")!;
  assertEquals(pac.a.map((t) => t.kind).sort(), ["contribution", "named"]);
  assertEquals(pac.b.map((t) => t.kind), ["named"]);
  const page = renderRace(dossier);
  assertStringIncludes(
    page,
    `<details class="shared sec" id="shared"><summary>Shared connections (1 of 3 pairs shares someone)`,
  );
  assertStringIncludes(page, "named in Endorsements and affiliations");
  assertStringIncludes(page, FILING);
  // Rows are capped per subject, so no overlap found says little; the page says so.
  assertStringIncludes(
    page,
    `keeps at most ${
      dossier.finance!.per_subject
    } contributions from the filings, so finding no shared contributor means little`,
  );
});

Deno.test("a run without the step still compares endorsements, and says money wasn't looked up", async () => {
  const { dossier } = await contextForRace(await race(), notes);
  const page = renderRace(dossier);
  assertStringIncludes(
    page,
    "weren&#39;t looked up in this run, so only endorsements are compared",
  );
  assert(!page.includes("Contributions on file"));
});

Deno.test("names from filings are escaped and only http(s) sources become links", async () => {
  const { dossier } = await financeForRace(
    await race(),
    researcher({
      "Acquanetta Warren": [gift("<script>alert(1)</script>", "$1")],
    }),
  );
  const page = renderRace(dossier);
  assert(!page.includes("<script>alert"));
  assertStringIncludes(page, "&lt;script&gt;");
});

const MEASURE: MeasureQuery = {
  label: "Measure X",
  jurisdiction: "City of Fontana",
  question: "",
  state: "CA",
  electionDate: "2026-11-03",
};

async function measure() {
  const port = new FakeResearch(listing([]), {}, {
    "Measure X": rawMeasure({
      sections: {
        case_for: section(fact("Supported by Friends of Fontana Parks.")),
        case_against: section(fact("Opposed by the Fontana Taxpayers Association.")),
      },
      retrieved_urls: [HERALD],
    }),
  });
  return await runMeasure(MEASURE, port);
}

Deno.test("a measure's two sides get one call, the same share, and are compared", async () => {
  const r = researcher({
    support: [gift("Inland Builders PAC", "$5,000"), gift("Fontana Developers LLC", "$2,000")],
    oppose: [
      gift("Inland Builders PAC", "$250", { source_url: FILING_2 }),
      gift("Fontana Developers", "$500"),
    ],
  });
  const { dossier } = await financeForMeasure(await measure(), r);
  assertEquals(r.requests[0].subjects.map((s) => s.role), ["support", "oppose"]);
  assertEquals(r.requests[0].perSubject, shareFor(2));
  const [pair] = measureConnections(dossier);
  assertEquals([pair.a, pair.b], ["Supporters", "Opponents"]);
  assertEquals(pair.shared.map((x) => x.ref.name), ["Inland Builders PAC"]);
  assertEquals(pair.possible.length, 1);
  const page = renderMeasure(dossier);
  assertStringIncludes(page, "Contributions on file: supporters");
  assertStringIncludes(page, "Contributions on file: opponents");
  assertStringIncludes(page, "Supporters and Opponents");
});

Deno.test("contributions join the graph as cited relations, and the graph answers what two share", async () => {
  const { dossier: noted } = await contextForRace(await race(), notes);
  const { dossier } = await financeForRace(
    noted,
    researcher({
      "Acquanetta Warren": [
        gift("Inland Builders PAC", "$1,000"),
        // Two identical rows on one filing stay two contributions.
        gift("Inland Builders PAC", "$1,000", { filing_period: "Late report" }),
        gift("Inland Builders PAC", "$1,000", {
          filing_period: "Late report",
          source_url: FILING_2,
        }),
        gift("Hidden Donor", "$9", { source_url: NEVER }),
      ],
      "Joz Sida": [gift("Inland Builders PAC", "$2,500", { source_url: FILING_2 })],
    }),
  );
  const p = projectRace(dossier, "run-1");
  const gifts = p.relations.filter((r) => r.relation === "contributed_to");
  // The unverified row adds nothing; a same-looking row on a second page may be a second gift.
  assertEquals(gifts.length, 4);
  assert(gifts.every((g) => g.citations?.length === 1));
  assertEquals(JSON.parse(gifts[0].detail!).amount, "$1,000");

  const s = await openStores(await Deno.makeTempDir());
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
  const kb = s.runs.knowledge;
  const warren = kb.entity(personRef("CA", "Fontana", "Acquanetta Warren").key)!;
  const sida = kb.entity(personRef("CA", "Fontana", "Joz Sida").key)!;
  const third = kb.entity(personRef("CA", "Fontana", "Third Person").key)!;
  const shared = kb.sharedBetween(warren.id, sida.id);
  assertEquals(shared.map((x) => x.entity.name), ["Inland Builders PAC"]);
  const [pac] = shared;
  assertEquals(pac.a.filter((t) => t.kind === "contribution").length, 3);
  assertEquals(pac.a.filter((t) => t.kind === "named").length, 1);
  const gave = pac.b.find((t) => t.kind === "contribution")!;
  assert(gave.kind === "contribution");
  assertEquals(gave.detail.amount, "$2,500");
  assertEquals(gave.citations.map((c) => c.url), [FILING_2]);
  assertEquals(kb.sharedBetween(warren.id, third.id), []);
  // Re-saving the run replaces its relations rather than adding to them.
  await s.runs.save({ ...(await s.runs.get("run-1"))!, updated_at: "2026-10-02T00:00:00Z" });
  assertEquals(kb.sharedBetween(warren.id, sida.id)[0].a.length, 4);
  s.db.close();
});

Deno.test("a measure's sides are entities, so the graph can compare them", async () => {
  const { dossier: noted } = await contextForMeasure(await measure(), notes);
  const { dossier } = await financeForMeasure(
    noted,
    researcher({
      support: [gift("Fontana Taxpayers Association", "$100")],
      oppose: [gift("Inland Builders PAC", "$250")],
    }),
  );
  const s = await openStores(await Deno.makeTempDir());
  await s.runs.save({
    id: "m-1",
    query: { ...QUERY, city: MEASURE.jurisdiction, office: MEASURE.label },
    measure: MEASURE,
    measure_result: dossier,
    candidates: null,
    status: "done",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    race: null,
  });
  const kb = s.runs.knowledge;
  const yes = kb.entity(sideRef(MEASURE, "support").key)!;
  const no = kb.entity(sideRef(MEASURE, "oppose").key)!;
  // The taxpayers' association opposes in the facts and gave to the yes side's committee.
  const shared = kb.sharedBetween(yes.id, no.id);
  assertEquals(shared.map((x) => x.entity.name), ["Fontana Taxpayers Association"]);
  assertEquals(shared[0].a.map((t) => t.kind), ["contribution"]);
  assertEquals(shared[0].b.map((t) => t.kind), ["named"]);
  s.db.close();
});

Deno.test("the job runner reads filings after context notes, and a failure leaves the run done", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const port = new FakeResearch(listing(CANDS.slice(0, 2)), {
    "Acquanetta Warren": raw({
      sections: { endorsements: section(fact("Endorsed by Inland Builders PAC.")) },
      retrieved_urls: [HERALD],
    }),
  });
  const order: string[] = [];
  let fail = false;
  const logs: string[] = [];
  const jobs = new JobRunner(s.runs, () => port, {
    log: (m) => logs.push(m),
    makeContextWriter: () => ({
      describeNames: (req) => {
        order.push("context");
        if (fail) return Promise.reject(new Error("context down"));
        return notes.describeNames(req);
      },
    }),
    makeFinanceResearcher: () => ({
      findContributions: async (req) => {
        order.push(`finance ${(await s.runs.list())[0]?.status}`);
        if (fail) throw new Error("response hit max_tokens before finishing");
        return researcher({ "Acquanetta Warren": [gift("Inland Builders PAC", "$1")] })
          .findContributions(req);
      },
    }),
  });
  const run = await jobs.submit(QUERY, CANDS.slice(0, 2));
  await jobs.idle();
  assertEquals(order, ["context", "finance done"]);
  const saved = (await s.runs.get(run.id))!;
  assertEquals(saved.status, "done");
  assertEquals(saved.race!.context?.notes.length, 1);
  assertEquals(saved.race!.finance?.subjects[0].contributions.length, 1);
  assert(logs.some((l) => l.includes("kept 1 contribution(s) for 2 subject(s)")));

  fail = true;
  // Another place, so the context step makes its (failing) call rather than reusing a note.
  const second = await jobs.submit({ ...QUERY, city: "Rialto" }, CANDS.slice(0, 2));
  await jobs.idle();
  const kept = (await s.runs.get(second.id))!;
  assertEquals(kept.status, "done");
  assertEquals(kept.race!.finance?.error, "response hit max_tokens before finishing");
  // The context step's failure record survives the finance step's save.
  assertEquals(kept.race!.context?.error, "context down");
  assert(logs.some((l) => l.includes("campaign finance failed: response hit max_tokens")));
  s.db.close();
});

const ONE = {
  labels: [{ subject: "Acquanetta Warren", candidate: 0 }],
  request: {
    subjects: [{ id: "s1", name: "Acquanetta Warren", role: "candidate" as const }],
    perSubject: 5,
  },
};

Deno.test("a long explanation is kept, cut and marked, never dropped like a record field", () => {
  const long = "Placeholder explanation. ".repeat(40);
  const f = checkFinance(ONE, {
    subjects: [subject("s1", [], { gap_note: long, not_listed: long })],
    portal_gaps: [{ portal: "County e-filing", url: "", problem: "javascript_only", note: long }],
    retrieved_urls: [FILING],
    model: "fake",
  });
  const [s] = f.subjects;
  assertEquals(s.gap_note!.length, MAX_NOTE_CHARS + 1);
  assert(s.gap_note!.endsWith("…"));
  assert(s.not_listed!.endsWith("…"));
  assertEquals(f.portal_gaps.length, 1);
  assert(f.portal_gaps[0].note.endsWith("…"));
});

Deno.test("a lookup that opened no page says nothing was checked, for every subject", () => {
  const two = {
    labels: [{ subject: "A", candidate: 0 }, { subject: "B", candidate: 1 }],
    request: {
      subjects: [
        { id: "s1", name: "A", role: "candidate" as const },
        { id: "s2", name: "B", role: "candidate" as const },
      ],
      perSubject: 5,
    },
  };
  const f = checkFinance(two, {
    subjects: [
      subject("s1", [gift("Inland Builders PAC", "$1,000")], {
        gap_note: "No committee was found.",
        searched: ["Cal-Access"],
      }),
    ],
    portal_gaps: [],
    retrieved_urls: [],
    model: "fake",
  });
  for (const s of f.subjects) {
    assertEquals(s.gap_note, NOTHING_OPENED);
    assertEquals(s.searched, []);
    assertEquals(s.contributions, []);
  }
});

Deno.test("a row repeated exactly counts once; a retrieved copy of an unretrieved row still stands", () => {
  const f = checkFinance(ONE, {
    subjects: [subject("s1", [
      gift("Inland Builders PAC", "$1,000", { source_url: NEVER }),
      gift("Inland Builders PAC", "$1,000"),
      gift("Inland Builders PAC", "$1,000"),
      // Same day, same amount, another filing: possibly a second check, so kept.
      gift("Inland Builders PAC", "$1,000", { filing: "Form 497" }),
    ])],
    portal_gaps: [],
    retrieved_urls: [FILING],
    model: "fake",
  });
  const [s] = f.subjects;
  assertEquals(s.contributions.map((c) => c.filing), ["Form 460, Schedule A", "Form 497"]);
  assertEquals(s.unverified.length, 1);
  assertEquals(s.dropped, 1);
});

Deno.test("placeholder occupations and employers never make two same-named people one", () => {
  const row = (occupation: string, employer: string) => ({
    contributor: "John Smith",
    contributor_type: "individual" as const,
    occupation,
    employer,
  });
  for (
    const [o, e] of [
      ["INFORMATION REQUESTED PER BEST EFFORTS", "INFORMATION REQUESTED PER BEST EFFORTS"],
      ["Not Applicable", "Not Applicable"],
      ["Owner", "Self-Employed"],
      ["N/A", "N/A"],
      ["Engineer", ""],
    ]
  ) {
    const a = contributorRef("CA", "Fontana", row(o, e), "1")!.key;
    const b = contributorRef("CA", "Fontana", row(o, e), "2")!.key;
    assert(a !== b, `${o} / ${e}`);
  }
});

Deno.test("near misses are flagged in any word order, and beside an exact match", async () => {
  const pat = { contributor_type: "individual", occupation: "Engineer", employer: "Acme Co" };
  const { dossier } = await financeForRace(
    await race(),
    researcher({
      "Acquanetta Warren": [
        gift("DOE, PAT", "$100", pat),
        gift("Smith Development", "$500"),
        gift("Smith Development LLC", "$500"),
      ],
      "Joz Sida": [gift("Pat Doe", "$100", pat), gift("Smith Development", "$750")],
    }),
  );
  const [ws] = raceConnections(dossier);
  assertEquals(ws.shared.map((x) => x.ref.name), ["Smith Development"]);
  const possible = ws.possible.map((p) => [p.a.sort().join(" / "), p.b.join(" / ")]);
  assertEquals(possible.sort(), [
    ["DOE, PAT", "Pat Doe"],
    ["Smith Development / Smith Development LLC", "Smith Development"],
  ]);
});

Deno.test("a county is one place however it is written, and still not its namesake city", () => {
  assertEquals(jurisdictionKey("County of San Bernardino"), "san bernardino county");
  assertEquals(jurisdictionKey("San Bernardino County"), "san bernardino county");
  assert(jurisdictionKey("City of San Bernardino") !== jurisdictionKey("County of San Bernardino"));
  assertEquals(jurisdictionKey("City & County of San Francisco"), "san francisco");
  assertEquals(jurisdictionKey("City and County of San Francisco"), "san francisco");
});

Deno.test("two candidates with one name each keep their own money", async () => {
  const twins: BallotCandidate[] = [
    { name: "Maria Garcia", ballot_designation: "Teacher", incumbent: false },
    { name: "Maria Garcia", ballot_designation: "Nurse", incumbent: false },
  ];
  const d = await runRace(QUERY, new FakeResearch(listing(twins), {}), { candidates: twins });
  const r: FinanceResearcher = {
    findContributions: (req) =>
      Promise.resolve({
        subjects: req.subjects.map((s, i) => subject(s.id, [gift(`Donor ${i}`, "$1")])),
        portal_gaps: [],
        retrieved_urls: [FILING],
        model: "fake",
      }),
  };
  const { dossier } = await financeForRace(d, r);
  assertEquals(dossier.finance!.subjects.map((s) => s.candidate), [0, 1]);
  const page = renderRace(dossier);
  assert(page.indexOf("Donor 0") < page.indexOf("Donor 1"));
  const [pair] = raceConnections(dossier);
  assertEquals(pair.shared, []);
});
