/**
 * The office-powers step: the key it is reused by, which facts and marks
 * stand, how it renders the same for every candidate, and how the job runner
 * looks an office up once and reuses it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkScopes,
  NO_POWERS_FOUND,
  NOT_SETTLED,
  OFFICE_REUSE_DAYS,
  officeForRace,
  officeKey,
  raceOfficeFailed,
  reusable,
} from "../src/office.ts";
import { runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { openStores } from "../src/web/store.ts";
import type {
  BallotCandidate,
  OfficeRequest,
  OfficeResearcher,
  RaceDossier,
  RawFact,
  RawIssueScope,
  RawOfficePowers,
  ScopeRequest,
} from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true },
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
];

const CHARTER = "https://www.fontanaca.gov/charter";
const NEWS = "https://www.fontanaheraldnews.com/council";
const ELSEWHERE = "https://example.com/made-up";

function fact(statement: string, url = CHARTER, extra: Partial<RawFact> = {}): RawFact {
  return {
    statement,
    source_name: url === CHARTER ? "City of Fontana" : "Fontana Herald News",
    source_url: url,
    author: null,
    published: "2025",
    event_date: "",
    evidence_type: "primary_record",
    quote: "",
    ...extra,
  };
}

function powers(overrides: Partial<RawOfficePowers> = {}): RawOfficePowers {
  return {
    sections: {
      decides: {
        facts: [
          fact("The council adopts the budget and sets zoning.", CHARTER, {
            quote: "The City Council of Fontana shall adopt the budget and set zoning",
          }),
          fact("Schools are run by Fontana Unified, not the city.", NEWS, {
            evidence_type: "unsourced",
          }),
          fact("The council sets rents.", ELSEWHERE),
        ],
        searched: ["city charter"],
        gap_note: null,
      },
      budget: {
        facts: [fact("The general fund is $250 million.", NEWS, {
          evidence_type: "reported",
          quote: "the general fund budget of about two hundred fifty million",
        })],
        searched: [],
        gap_note: null,
      },
    },
    gaps: ["The municipal code site wouldn't load."],
    retrieved_urls: [CHARTER, NEWS],
    opened_pages: [
      {
        url: CHARTER,
        text: "The City Council of Fontana shall adopt the budget and set zoning.",
      },
      { url: NEWS, text: "Council approves the general fund budget." },
    ],
    model: "fake-office",
    effort: { searches: 2, fetches: 2 },
    ...overrides,
  };
}

class FakeOffice implements OfficeResearcher {
  lookups: OfficeRequest[] = [];
  scopes: ScopeRequest[] = [];
  constructor(
    readonly result: RawOfficePowers | Error = powers(),
    readonly marks: (r: ScopeRequest) => RawIssueScope[] | Error = (r) =>
      r.issues.map((x) => ({
        id: x.id,
        scope: "inside",
        basis: "It adopts the budget.",
        fact_ids: ["f1"],
      })),
  ) {}
  findOfficePowers(request: OfficeRequest): Promise<RawOfficePowers> {
    this.lookups.push(request);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
  markIssueScopes(request: ScopeRequest): Promise<RawIssueScope[]> {
    this.scopes.push(request);
    const m = this.marks(request);
    return m instanceof Error ? Promise.reject(m) : Promise.resolve(m);
  }
}

async function race(priorities: string[] = []): Promise<RaceDossier> {
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw(),
    "Joz Sida": raw(),
  });
  return await runRace(QUERY, port, { candidates: CANDS, priorities });
}

Deno.test("the office key leaves out the seat, not the office", () => {
  const k = (o: string) => officeKey("CA", "Fontana", o);
  assertEquals(k("Member, City Council, District 2"), k("Member, City Council, District 4"));
  assertEquals(k("Governing Board Member, Trustee Area 3"), k("Governing Board Member"));
  assertEquals(k("Judge of the Superior Court, Office No. 12"), k("Judge of the Superior Court"));
  assert(k("District Attorney") !== k("Attorney"));
  assertEquals(k("Mayor"), officeKey("CA", "City of Fontana", "mayor"));
  assert(k("Mayor") !== officeKey("CA", "Rialto", "Mayor"));
});

Deno.test("office facts get the provenance and quote check, and marks need a sourced fact", async () => {
  const r = await race(["housing costs", "school quality", "rent control", "parks"]);
  const office = new FakeOffice(powers(), (req) =>
    [
      { id: "i1", scope: "inside", basis: "It sets zoning.", fact_ids: ["f1"] },
      // Cites only an unsourced fact: not enough.
      { id: "i2", scope: "outside", basis: "Schools are separate.", fact_ids: ["f2"] },
      // Cites nothing.
      { id: "i3", scope: "outside", basis: "", fact_ids: [] },
      { id: "i4", scope: "maybe", basis: "", fact_ids: ["f1"] },
    ].filter((x) => req.issues.some((i) => i.id === x.id)));
  const { dossier, looked_up, shown, marked } = await officeForRace(r, office);
  const o = dossier.office!;
  assert(looked_up);
  assertEquals(shown, 3);
  assertEquals(marked, 4);
  assertEquals(office.lookups[0], {
    place: "Fontana, CA",
    office: "Mayor",
    electionDate: "2026-11-03",
  });
  // Nothing about the candidates is sent with the lookup or the marks.
  assert(!JSON.stringify(office.scopes).includes("Warren"));
  assertEquals(office.scopes[0].facts.map((f) => f.id), ["f1", "f2", "f3"]);

  const decides = o.sections.decides.facts;
  assertEquals(decides.length, 2);
  assertEquals(decides[0].check?.level, "quoted");
  assertEquals(o.unverified.map((f) => f.source_url), [ELSEWHERE]);
  // No name check: the budget page doesn't name the city and isn't flagged.
  assertEquals(o.sections.budget.facts[0].check?.missing_name, undefined);
  assertEquals(o.sections.budget.facts[0].check?.level, "not_found");
  assertEquals(o.sections.seats.facts.length, 0);
  assert(o.sections.seats.gap_note);
  assertEquals(o.effort, { searches: 2, fetches: 2 });

  assertEquals(o.issues.map((x) => x.scope), ["inside", "unclear", "unclear", "unclear"]);
  assertEquals(o.issues[0].rests_on, [{ section: "decides", index: 0 }]);
  assertEquals(o.issues[1].basis, NOT_SETTLED);
});

Deno.test("no issues means no marking call; no verified fact means every issue is unclear", async () => {
  const none = new FakeOffice();
  await officeForRace(await race(), none);
  assertEquals(none.scopes.length, 0);

  const empty = new FakeOffice(powers({ retrieved_urls: [] }));
  const { dossier } = await officeForRace(await race(["housing"]), empty);
  assertEquals(empty.scopes.length, 0);
  assertEquals(dossier.office!.issues, [{
    issue: "housing",
    scope: "unclear",
    basis: NO_POWERS_FOUND,
    rests_on: [],
  }]);
  assertEquals(reusable(dossier.office, { id: "r", updated_at: "2026-10-30" }, new Date()), null);
});

Deno.test("a failed marking call keeps the powers; a failed lookup says so", async () => {
  const office = new FakeOffice(powers(), () => new Error("refused"));
  const { dossier } = await officeForRace(await race(["housing"]), office);
  assertEquals(dossier.office!.scope_error, "refused");
  assertEquals(dossier.office!.issues[0].scope, "unclear");
  assertEquals(dossier.office!.sections.decides.facts.length, 2);

  const failed = raceOfficeFailed(await race(["housing"]), "max_tokens");
  assertEquals(failed.office!.error, "max_tokens");
  assertEquals(failed.office!.issues[0].scope, "unclear");
  assertStringIncludes(renderRace(failed), "failed in this run (max_tokens)");
});

Deno.test("a reused lookup makes no lookup call and keeps marks only for the same words", async () => {
  const first = new FakeOffice();
  const at = "2026-10-01T00:00:00.000Z";
  const { dossier } = await officeForRace(await race(["Housing costs"]), first, null, new Date(at));
  // The lookup's own time counts, not when the run was last saved.
  const known = reusable(dossier.office, { id: "run-1", updated_at: "2027-01-01" }, new Date(at))!;
  assertEquals(known.from, { run: "run-1", looked_up: at });

  const second = new FakeOffice(new Error("should not be called"));
  const r = await officeForRace(await race(["housing costs", "parks"]), second, known);
  assert(!r.looked_up);
  assertEquals(second.lookups.length, 0);
  // Only the new issue was sent; the other kept the earlier mark, in this run's words.
  assertEquals(second.scopes[0].issues, [{ id: "i1", issue: "parks" }]);
  const o = r.dossier.office!;
  assertEquals(o.issues.map((x) => x.issue), ["housing costs", "parks"]);
  assertEquals(o.reused_from, { run: "run-1", looked_up: at });
  assertEquals(o.effort, undefined);
  // A run that reused it passes on where it came from.
  const again = reusable(o, { id: "run-2", updated_at: "2026-10-20" }, new Date(at))!;
  assertEquals(again.from.run, "run-1");

  const late = new Date(Date.parse(at) + (OFFICE_REUSE_DAYS + 1) * 86_400_000);
  assertEquals(reusable(dossier.office, { id: "run-1", updated_at: at }, late), null);
});

Deno.test("checkScopes takes the first answer per issue and drops a basis too long to show", () => {
  const r = powers();
  const sections = {
    decides: {
      facts: [{
        statement: "Adopts the budget.",
        source_name: "City",
        source_url: CHARTER,
        author: null,
        published: null,
        evidence_type: "primary_record" as const,
      }],
      searched: [],
      gap_note: null,
    },
    budget: { facts: [], searched: [], gap_note: "none" },
    seats: { facts: [], searched: [], gap_note: "none" },
    term: { facts: [], searched: [], gap_note: "none" },
  };
  assert(r);
  const out = checkScopes(["housing"], sections, [
    { id: "i1", scope: "partly", basis: "x".repeat(400), fact_ids: ["f1", "f1", "f9"] },
    { id: "i1", scope: "outside", basis: "Second.", fact_ids: ["f1"] },
  ]);
  assertEquals(out, [{
    issue: "housing",
    scope: "partly",
    basis: null,
    rests_on: [{ section: "decides", index: 0 }],
  }]);
});

Deno.test("the page shows the office once and the same mark under every candidate", async () => {
  const office = new FakeOffice(powers(), (req) =>
    req.issues.map((x) => ({
      id: x.id,
      scope: "outside",
      basis: "Schools are run <b>by</b> the district.",
      fact_ids: ["f1"],
    })));
  const { dossier } = await officeForRace(await race(["school quality"]), office);
  const page = renderRace(dossier);
  assertStringIncludes(page, `<section class="office" id="office">`);
  assertStringIncludes(page, `<a href="#office">Office</a>`);
  assertStringIncludes(page, "Schools are run &lt;b&gt;by&lt;/b&gt; the district.");
  assertStringIncludes(
    page,
    `<span class="scope-mark scope-outside">Outside this office&#39;s say</span>`,
  );
  // Under each candidate's issue: the same line, twice.
  const line = `<p class="scope scope-outside">Outside this office&#39;s say. <a href="#office">`;
  assertEquals(page.split(line).length - 1, 2);
  assertStringIncludes(page, "Looked up in this run: 2 searches and 2 pages opened.");
  // Never a stance color on the office mark.
  assert(!/scope[^"]*stance-/.test(page));
});

Deno.test("a race saved before the step renders without an office section", async () => {
  const page = renderRace(await race(["housing"]));
  assert(!page.includes(`id="office"`));
  assert(!page.includes(`class="scope`));
});

Deno.test("the job runner looks an office up once and reuses it for the same office in the place", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const port = new FakeResearch(listing(CANDS), {
    "Acquanetta Warren": raw(),
    "Joz Sida": raw(),
  });
  const office = new FakeOffice();
  const logs: string[] = [];
  const jobs = new JobRunner(s.runs, () => port, {
    log: (m) => logs.push(m),
    makeOfficeResearcher: () => office,
  });
  const council = { ...QUERY, office: "Member, City Council, District 2" };
  const first = await jobs.submit(council, CANDS, null, { priorities: ["housing"] });
  await jobs.idle();
  const one = (await s.runs.get(first.id))!;
  assertEquals(one.race!.office?.issues[0].scope, "inside");
  assertEquals(office.lookups.length, 1);

  const second = await jobs.submit(
    { ...council, office: "Member, City Council, District 4" },
    CANDS,
    null,
    {
      priorities: ["housing"],
    },
  );
  await jobs.idle();
  const two = (await s.runs.get(second.id))!;
  assertEquals(office.lookups.length, 1);
  // Same words: the mark is reused too, so no marking call either.
  assertEquals(office.scopes.length, 1);
  assertEquals(two.race!.office?.reused_from?.run, first.id);
  assert(logs.some((l) => l.includes(`reused the office lookup from ${first.id}`)));

  // Another place: looked up again.
  await jobs.submit({ ...council, city: "Rialto" }, CANDS);
  await jobs.idle();
  assertEquals(office.lookups.length, 2);
  s.db.close();
});

Deno.test("a failed lookup leaves the run done and says why", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const port = new FakeResearch(listing(CANDS), { "Acquanetta Warren": raw(), "Joz Sida": raw() });
  const jobs = new JobRunner(s.runs, () => port, {
    makeOfficeResearcher: () => new FakeOffice(new Error("overloaded")),
  });
  const run = await jobs.submit(QUERY, CANDS, null, { priorities: ["housing"] });
  await jobs.idle();
  const saved = (await s.runs.get(run.id))!;
  assertEquals(saved.status, "done");
  assertEquals(saved.race!.office?.error, "overloaded");
  // A failed lookup is never reused.
  assertEquals(s.runs.knownOffice(QUERY, "other", new Date()), null);
  s.db.close();
});

Deno.test("a mark can't rest on a fact whose quote wasn't on its opened page", () => {
  const facts = (level: "quoted" | "not_found") => ({
    decides: {
      facts: [{
        statement: "Sets zoning.",
        source_name: "City",
        source_url: CHARTER,
        author: null,
        published: null,
        evidence_type: "primary_record" as const,
        check: { level, opened: true, read: true },
      }],
      searched: [],
      gap_note: null,
    },
    budget: { facts: [], searched: [], gap_note: "none" },
    seats: { facts: [], searched: [], gap_note: "none" },
    term: { facts: [], searched: [], gap_note: "none" },
  });
  const raw = [{ id: "i1", scope: "inside", basis: "It sets zoning.", fact_ids: ["f1"] }];
  assertEquals(checkScopes(["housing"], facts("quoted"), raw)[0].scope, "inside");
  assertEquals(checkScopes(["housing"], facts("not_found"), raw)[0], {
    issue: "housing",
    scope: "unclear",
    basis: NOT_SETTLED,
    rests_on: [],
  });
});
