/**
 * The NetFile adapter: which place is NetFile's, which committees are a
 * subject's, rows kept as the export states them, the larger share the same
 * for everyone, and the model lookup as the fallback for every subject alike.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  checkFinance,
  financeForRace,
  MAX_EXPORT_PER_SUBJECT,
  NOTHING_OPENED,
  shareFor,
} from "../src/finance.ts";
import {
  agencyFor,
  agencyKey,
  type ExportRow,
  type ExportYear,
  filerMatches,
  type NetFileAgency,
  NetFileClient,
  NetFileResearcher,
  type NetFileSource,
  parseAgencyMap,
} from "../src/netfile.ts";
import { runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import type {
  BallotCandidate,
  FinanceRequest,
  FinanceResearcher,
  RaceDossier,
} from "../src/types.ts";
import { FakeResearch, listing, raw } from "./fakes.ts";

const OAKLAND = { city: "Oakland", state: "CA", office: "Mayor", electionDate: "2026-11-03" };
const CANDS: BallotCandidate[] = [
  { name: "Jane Q. Smith", ballot_designation: null, incumbent: true },
  { name: "Luis Ortega Jr.", ballot_designation: null, incumbent: false },
  { name: "Pat Lee", ballot_designation: null, incumbent: false },
];
const AGENCIES: NetFileAgency[] = [
  { id: "COAK", name: "Oakland, City of" },
  { id: "SFO", name: "San Francisco Ethics Commission" },
  { id: "CALA", name: "County of Alameda" },
];

function row(over: Record<string, unknown> = {}): ExportRow {
  return {
    filerid: "1001",
    filernaml: "Jane Smith for Mayor 2026",
    committeetype: "CTL",
    formtype: "A",
    entitycd: "IND",
    trannamf: "Ann",
    trannaml: "Donor",
    tranocc: "Teacher",
    tranemp: "OUSD",
    tranamt1: 250,
    trandate: "2026-03-02T00:00:00",
    fromdate: "2026-01-01T00:00:00",
    thrudate: "2026-06-30T00:00:00",
    filingid: "198578683",
    ...over,
  };
}

const exportUrl = (y: number) =>
  `https://netfile.com/Connect2/api/public/campaign/export/cal201/transaction/year?Year=${y}&AID=COAK&Format=json`;

/** A NetFile with a fixed agency list and rows per year, counting what is read. */
function fakeSource(
  rows: Record<number, ExportRow[] | Error>,
  agencies = AGENCIES,
): NetFileSource & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    agencies: () => Promise.resolve(agencies),
    transactions: (_aid: string, year: number): Promise<ExportYear> => {
      reads.push(year);
      const r = rows[year] ?? [];
      return r instanceof Error
        ? Promise.reject(r)
        : Promise.resolve({ year, url: exportUrl(year), rows: r, truncated: false });
    },
  };
}

function fallback(): FinanceResearcher & { calls: FinanceRequest[] } {
  const calls: FinanceRequest[] = [];
  return {
    calls,
    findContributions: (req) => {
      calls.push(req);
      return Promise.resolve({
        subjects: [],
        portal_gaps: [],
        retrieved_urls: [],
        model: "fallback",
      });
    },
  };
}

async function race(): Promise<RaceDossier> {
  const port = new FakeResearch(listing(CANDS), {
    "Jane Q. Smith": raw(),
    "Luis Ortega Jr.": raw(),
    "Pat Lee": raw(),
  });
  return await runRace(OAKLAND, port, { candidates: CANDS });
}

const subject = (name: string, role: "candidate" | "support" | "oppose" = "candidate") => ({
  id: "s1",
  name,
  role,
});

Deno.test("a place is NetFile's only by one agency's name, in California", async () => {
  assertEquals(agencyKey("Oakland, City of"), "oakland");
  assertEquals(agencyKey("City of Oakland"), "oakland");
  assertEquals(agencyKey("San Francisco Ethics Commission"), "san francisco");
  assertEquals(agencyKey("Alameda, County of"), "alameda county");
  const src = fakeSource({});
  assertEquals((await agencyFor("Oakland, CA", src))?.id, "COAK");
  assertEquals((await agencyFor("Alameda County, California", src))?.id, "CALA");
  assertEquals(await agencyFor("Alameda, CA", src), null, "the county is not the city");
  assertEquals(await agencyFor("Oakland, OR", src), null);
  assertEquals(await agencyFor("Fontana, CA", src), null);
  // Two agencies by one name: never a guess between them.
  const twice = fakeSource({}, [...AGENCIES, { id: "COAK2", name: "City of Oakland" }]);
  assertEquals(await agencyFor("Oakland, CA", twice), null);
  // Set by hand: used without the list.
  const map = parseAgencyMap("Fontana=CFON; bad entry; X=not ok!");
  assertEquals([...map.keys()], ["fontana"]);
  assertEquals((await agencyFor("Fontana, CA", src, map))?.id, "CFON");
});

Deno.test("a committee is a candidate's only by first and last name, never against them", () => {
  const f = (name: string, type = "CTL") => ({ id: "1", name, type });
  const jane = subject("Jane Q. Smith");
  assert(filerMatches(f("Jane Smith for Mayor 2026"), jane, 2026));
  assert(filerMatches(f("Committee to Elect Jane Q. Smith"), jane, 2026));
  assert(filerMatches(f("Jane Smith for Mayor", ""), jane, 2026), "type not stated");
  assert(!filerMatches(f("Re-elect Smith"), jane, 2026), "surname only");
  assert(!filerMatches(f("Recall Jane Smith"), jane, 2026));
  assert(!filerMatches(f("Oaklanders Against Jane Smith"), jane, 2026));
  assert(!filerMatches(f("Jane Smith for Council 2022"), jane, 2026), "another election");
  assert(!filerMatches(f("Jane Smith Ballot Committee", "BMC"), jane, 2026));
  assert(!filerMatches(f("Jane Smithson for Mayor"), jane, 2026), "whole words only");
  assert(filerMatches(f("Luis Ortega for Mayor"), subject("Luis Ortega Jr."), 2026));
  assert(!filerMatches(f("Cher for Mayor"), subject("Cher"), 2026), "one name is too little");

  const yes = subject("Measure W", "support"), no = subject("Measure W", "oppose");
  assert(filerMatches(f("Yes on Measure W", "BMC"), yes, 2026));
  assert(filerMatches(f("Oaklanders for Measure W"), yes, 2026));
  assert(filerMatches(f("No on Measure W, Taxpayers Assn"), no, 2026));
  assert(!filerMatches(f("Yes on Measure W"), no, 2026));
  assert(!filerMatches(f("Yes on Measure WW"), yes, 2026));
  assert(!filerMatches(f("Yes on V, No on Measure W"), yes, 2026), "both sides");
  assert(!filerMatches(f("Yes on V, No on Measure W"), no, 2026), "both sides");
  assert(filerMatches(f("Yes on Prop. 50"), subject("Proposition 50", "support"), 2026));
});

Deno.test("rows come from the export as it states them, the larger share for everyone", async () => {
  const source = fakeSource({
    2025: [row({ trannamf: "Early", tranamt1: 100, trandate: "2025-11-01T00:00:00" })],
    2026: [
      row(),
      row({
        entitycd: "COM",
        trannamf: "",
        trannaml: "Builders PAC",
        tranocc: "",
        tranemp: "",
        tranamt1: "1000.00",
      }),
      // A late contribution reported again on the 460: kept once, as the 460 has it.
      row({ formtype: "F497P1", filingid: "200" }),
      row({ formtype: "F497P1", trannamf: "Late", filingid: "200" }),
      // Pat Lee's committee; Luis Ortega has none.
      row({ filerid: "2002", filernaml: "Pat Lee for Oakland Mayor", trannaml: "Giver" }),
      // A recall committee names Jane Smith: never hers.
      row({ filerid: "3003", filernaml: "Recall Jane Smith", committeetype: "PAC" }),
    ],
  });
  const fb = fallback();
  const money = new NetFileResearcher({ source, fallback: fb });
  const { dossier } = await financeForRace(await race(), money);
  assertEquals(fb.calls.length, 0);
  assertEquals(source.reads, [2025, 2026], "the year before counts too");
  const f = dossier.finance!;
  assertEquals(f.per_subject, MAX_EXPORT_PER_SUBJECT);
  assertEquals(f.source, {
    kind: "netfile",
    agency: "COAK",
    agency_name: "City of Oakland",
    years: [2025, 2026],
  });
  const [jane, luis, pat] = f.subjects;
  assertEquals(jane.committees, ["Jane Smith for Mayor 2026"]);
  assertEquals(
    jane.contributions.map((c) => [c.contributor, c.amount, c.date, c.filing]),
    [
      ["Builders PAC", "1000.00", "2026-03-02", "Form 460, Schedule A, filing 198578683"],
      ["Ann Donor", "250", "2026-03-02", "Form 460, Schedule A, filing 198578683"],
      ["Late Donor", "250", "2026-03-02", "Form 497, Part 1, filing 200"],
      ["Early Donor", "100", "2025-11-01", "Form 460, Schedule A, filing 198578683"],
    ],
  );
  const ann = jane.contributions[1];
  assertEquals(ann.contributor_type, "individual");
  assertEquals([ann.occupation, ann.employer], ["Teacher", "OUSD"]);
  assertEquals(ann.filing_period, "2026-01-01 to 2026-06-30");
  assertEquals(ann.source_url, exportUrl(2026));
  assertEquals(ann.filing_url, "https://netfile.com/Connect2/api/public/image/198578683");
  assert(ann.verified);
  assertEquals(jane.contributions[0].contributor_type, "organization");
  assertEquals(jane.gap_note, null);
  assertEquals(luis.contributions, []);
  assertStringIncludes(luis.gap_note!, "first and last name");
  assertStringIncludes(luis.gap_note!, "not evidence there is none");
  assertEquals(pat.contributions.map((c) => c.contributor), ["Ann Giver"]);

  const page = renderRace(dossier);
  assertStringIncludes(page, "taken from City of Oakland's NetFile export (2025, 2026)");
  assertStringIncludes(page, 'href="https://netfile.com/Connect2/api/public/image/198578683"');
  assert(!page.includes("Recall Jane Smith"));
});

Deno.test("a committee two subjects' names fit is kept for neither", async () => {
  const two: BallotCandidate[] = [
    { name: "Pat Lee", ballot_designation: null, incumbent: false },
    { name: "Pat Lee", ballot_designation: null, incumbent: false },
    { name: "Jane Smith", ballot_designation: null, incumbent: false },
  ];
  const port = new FakeResearch(listing(two), { "Pat Lee": raw(), "Jane Smith": raw() });
  const r = await runRace(OAKLAND, port, { candidates: two });
  const source = fakeSource({
    2026: [row(), row({ filerid: "2002", filernaml: "Pat Lee for Mayor" })],
  });
  const { dossier } = await financeForRace(r, new NetFileResearcher({ source }));
  const [a, b, jane] = dossier.finance!.subjects;
  for (const s of [a, b]) {
    assertEquals(s.contributions, []);
    assertStringIncludes(s.gap_note!, "kept for neither: Pat Lee for Mayor");
  }
  assertEquals(jane.contributions.length, 1);
});

Deno.test("elsewhere, or with nothing matched or readable, the model looks up everyone", async () => {
  // Not on NetFile: the fallback, with nothing said.
  const fb = fallback();
  const fontana = { place: "Fontana, CA", contest: "Mayor", electionDate: "2026-11-03" };
  const req: FinanceRequest = {
    ...fontana,
    subjects: [subject("Jane Smith")],
    perSubject: shareFor(1),
  };
  let r = await new NetFileResearcher({ source: fakeSource({}), fallback: fb })
    .findContributions(req);
  assertEquals(fb.calls.length, 1);
  assertEquals(r.portal_gaps, []);
  assertEquals(r.source, undefined);

  // On NetFile, but no committee fits anyone: the fallback, and the page says why.
  const oak = { ...req, place: "Oakland, CA" };
  r = await new NetFileResearcher({
    source: fakeSource({ 2026: [row({ filernaml: "Someone Else for Mayor" })] }),
    fallback: fb,
  }).findContributions(oak);
  assertEquals(fb.calls.length, 2);
  assertStringIncludes(r.portal_gaps[0].note, "matched a candidate or side");
  assertStringIncludes(r.portal_gaps[0].note, "looked up by the model instead");

  // The export can't be read at all: the same.
  r = await new NetFileResearcher({
    source: fakeSource({ 2025: new Error("503"), 2026: new Error("503") }),
    fallback: fb,
  }).findContributions(oak);
  assertEquals(fb.calls.length, 3);
  assertStringIncludes(r.portal_gaps[0].note, "couldn't be read");

  // One year unreadable: the other is used, and the gap is shown.
  r = await new NetFileResearcher({
    source: fakeSource({ 2025: new Error("503"), 2026: [row()] }),
    fallback: fb,
  }).findContributions(oak);
  assertEquals(fb.calls.length, 3);
  assertEquals(r.source?.years, [2026]);
  assertStringIncludes(r.portal_gaps[0].note, "503");

  // Without a fallback, the step fails (and the page says so for everyone).
  await assertRejects(
    () => new NetFileResearcher({ source: fakeSource({}) }).findContributions(req),
    Error,
    "No NetFile agency for Fontana, CA",
  );
});

Deno.test("only a named export source gets the larger share", () => {
  const plan = {
    labels: [{ subject: "A", candidate: 0 }],
    request: { subjects: [subject("A")], perSubject: 5 },
  };
  const base = { subjects: [], portal_gaps: [], retrieved_urls: [], model: "m" };
  assertEquals(checkFinance(plan, { ...base, per_subject: 500 }).per_subject, 5);
  const src = { kind: "netfile" as const, agency: "X", agency_name: "X", years: [2026] };
  assertEquals(checkFinance(plan, { ...base, per_subject: 500, source: src }).per_subject, 500);
  assertEquals(
    checkFinance(plan, { ...base, per_subject: 1e9, source: src }).per_subject,
    MAX_EXPORT_PER_SUBJECT,
  );
  assertEquals(checkFinance(plan, base).subjects[0].gap_note, NOTHING_OPENED);
});

Deno.test("the client pages through a year, keeps contributions, and reads agencies once", async () => {
  const asked: string[] = [];
  const pages = [
    {
      totalMatchingPages: 2,
      results: [
        { Filer_NamL: "Jane Smith for Mayor", Form_Type: "A", Tran_Amt1: 5 },
        { Filer_NamL: "Jane Smith for Mayor", Form_Type: "E", Tran_Amt1: 9 },
      ],
    },
    { totalMatchingPages: 2, results: [{ filerName: "X", formType: "C", tranAmt1: 7 }] },
  ];
  let agencyReads = 0;
  const client = new NetFileClient({
    fetch: (url) => {
      asked.push(url);
      if (url.includes("/list/agencies")) {
        agencyReads++;
        return Promise.resolve(Response.json([{ id: 13, shortcut: "COAK", name: "Oakland" }]));
      }
      const page = Number(new URL(url).searchParams.get("CurrentPageIndex"));
      return Promise.resolve(Response.json(pages[page]));
    },
  });
  const y = await client.transactions("COAK", 2026);
  assertEquals(asked.length, 2);
  assertEquals(y.url, exportUrl(2026));
  assertEquals(y.rows.map((r) => r.tranamt1), [5, 7], "expenditures are left out");
  assertEquals(y.truncated, false);
  await client.agencies();
  assertEquals(await client.agencies(), [{ id: "COAK", name: "Oakland" }]);
  assertEquals(agencyReads, 1);

  const failing = new NetFileClient({
    fetch: () => Promise.resolve(new Response("no", { status: 500 })),
  });
  await assertRejects(() => failing.transactions("COAK", 2026), Error, "NetFile answered 500");
});
