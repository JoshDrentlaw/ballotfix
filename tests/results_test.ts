/**
 * Election results (roadmap item 19): parsing both sources, matching a
 * ballot's items to counts by their own words, keeping each distinct count
 * once, and the pages that show them in ballot order with no winner named.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkResults,
  type ContestCount,
  districtOf,
  inCountWindow,
  matchResults,
  parseCountyPage,
  parseSosFeed,
  personKey,
  resultNames,
  sosPathFor,
  sosPaths,
} from "../src/results.ts";
import type { BallotReading } from "../src/types.ts";
import { ResultsChecker } from "../src/web/results_check.ts";
import { resultBox, standing } from "../src/web/results_view.ts";
import { resultsPage } from "../src/web/pages.ts";
import { openStores } from "../src/web/store.ts";

const SOS = "https://api.sos.ca.gov/returns";
const COUNTY = "https://results.rov.sbcounty.gov/Results/20261103/";

const reading: BallotReading = {
  election_date: "2026-11-03",
  state: "CA",
  county: "San Bernardino",
  contests: [
    {
      office: "Governor",
      jurisdiction: "State Offices",
      vote_for: 1,
      candidates: [
        { name: "XAVIER BECERRA", ballot_designation: null, incumbent: false },
        { name: "STEVE HILTON", ballot_designation: null, incumbent: false },
      ],
    },
    {
      office: "Secretary of State",
      jurisdiction: "State Offices",
      vote_for: 1,
      candidates: [
        { name: "SHIRLEY N. WEBER", ballot_designation: null, incumbent: true },
        { name: "DONALD P. (DON) WAGNER", ballot_designation: null, incumbent: false },
      ],
    },
    {
      office: "City Clerk",
      jurisdiction: "City of Fontana Offices",
      vote_for: 1,
      candidates: [
        { name: "GERMAINE KEY", ballot_designation: null, incumbent: false },
        { name: "JOE ALVANEZ", ballot_designation: null, incumbent: false },
        { name: "DANIEL QUIROGA", ballot_designation: null, incumbent: false },
      ],
    },
    {
      office: "Member, City Council District 9",
      jurisdiction: "City of Fontana Offices",
      vote_for: 1,
      candidates: [{ name: "NOBODY COUNTED", ballot_designation: null, incumbent: false }],
    },
  ],
  measures: [
    {
      kind: "retention",
      label: "For Associate Justice, Court of Appeal, Fourth District, Division One",
      jurisdiction: "State of California",
      question: "",
      person: "JOSE S. CASTILLO",
    },
    {
      kind: "measure",
      label: "Proposition 40",
      jurisdiction: "State of California",
      question: "",
      person: "",
    },
    {
      kind: "measure",
      label: "Measure I",
      jurisdiction: "San Bernardino County",
      question: "",
      person: "",
    },
  ],
  notes: null,
  model: "test",
};

const FEEDS: Record<string, unknown> = {
  governor: {
    raceTitle: "Governor - Statewide Results",
    Reporting: "100.0% (23,860 of 23,860) precincts reporting",
    ReportingTime: "November 4, 2026, 8:08 a.m.",
    candidates: [
      { Name: "Xavier Becerra", Party: "Dem", Votes: "4,992,161", Percent: "63.9" },
      { Name: "Steve Hilton", Party: "Rep", Votes: "2,820,000", Percent: "36.1" },
    ],
  },
  "secretary-of-state": {
    raceTitle: "Secretary of State - Statewide Results",
    Reporting: "100.0% (23,860 of 23,860) precincts reporting",
    ReportingTime: "November 4, 2026, 8:08 a.m.",
    candidates: [
      { Name: "Donald P. Wagner", Party: "Rep", Votes: "2,700,000", Percent: "35.3" },
      { Name: "Shirley N. Weber", Party: "Dem", Votes: "4,983,791", Percent: "64.7" },
    ],
  },
  "courts-of-appeal/district/4": {
    raceTitle: "Courts of Appeal District 4 - Districtwide Results",
    Reporting: "100.0% (8,938 of 8,938) precincts reporting",
    ReportingTime: "November 4, 2026, 8:08 a.m.",
    "courts-of-appeal": [
      {
        Name: "Jose S. Castillo",
        yesVotes: "1215146",
        yesPercent: "69.2",
        noVotes: "541330",
        noPercent: "30.8",
      },
    ],
  },
  "ballot-measures": {
    raceTitle: "Ballot Measures - Statewide Results",
    Reporting: "100.0% (23,860 of 23,860) precincts reporting",
    ReportingTime: "November 4, 2026, 8:08 a.m.",
    "ballot-measures": [
      {
        Name: "Imposes One-Time Tax.",
        Number: "40",
        yesVotes: "3000000",
        yesPercent: "44.4",
        noVotes: "3757000",
        noPercent: "55.6",
      },
      {
        Name: "Something else.",
        Number: "04",
        yesVotes: "1",
        yesPercent: "48",
        noVotes: "2",
        noPercent: "52",
      },
    ],
  },
};

const contest = (n: number, title: string, rows: [string, string, string][]) =>
  `<a class="anchor" id="cont${n}"></a><table id="electionResultsTable${n}"><tbody><tr><td>
<h2>${title} (Vote for  1)</h2><div class="row"><div class="col-md-12">Precincts Reported: 70 of 70 (100.00%)</div></div>
<table id="electionResultsContestStats${n}"><tbody><tr><td>Times Cast</td><td align="right">32,033 / 124,010</td><td align="right">25.83%</td></tr></tbody></table>
<table id="electionContests${n}"><thead><tr><th>Candidate</th><th>Party</th><th colspan="2">Total</th></tr></thead><tbody>
${
    rows.map(([name, votes, pct]) =>
      `<tr><td>${name}</td><td align="center">   </td><td align="right">${votes}</td><td align="right">${pct}</td></tr>`
    ).join("")
  }<tr><td colspan="2">Total Votes</td><td align="right">1</td><td></td></tr></tbody></table></td></tr></tbody></table>`;

const PAGE = `<html><head><script>var x = "<h2>not a contest</h2>";</script></head><body>
<a href="#">REFRESH</a> Final Unofficial Election Night Results Next Update: November 5, 2026 By 6 p.m.
<h3>Summary Report #5</h3>
${
  contest(1, "State of California Governor", [["XAVIER BECERRA", "196,000", "40.00%"], [
    "STEVE HILTON",
    "294,000",
    "60.00%",
  ]])
}
${
  contest(2, "City of Fontana City Clerk", [["GERMAINE KEY", "12,149", "42.39%"], [
    "JOE ALVANEZ",
    "10,362",
    "36.15%",
  ], ["DANIEL QUIROGA", "6,133", "21.40%"]])
}
${
  contest(3, "San Bernardino County MEASURE I", [["YES", "196,895", "66.09%"], [
    "NO",
    "101,021",
    "33.91%",
  ]])
}
${contest(4, "City of Needles MEASURE I", [["YES", "10", "50.00%"], ["NO", "10", "50.00%"]])}
${
  contest(
    5,
    "State of California Associate Justice, Court of Appeal 4th Appellate District, Division 1 (JOSE S. CASTILLO)",
    [["YES", "100", "70.00%"], ["NO", "43", "30.00%"]],
  )
}
</body></html>`;

const fetcher = (fail: string[] = []) => (url: string) => {
  if (fail.some((f) => url.includes(f))) return Promise.reject(new Error("HTTP 503"));
  if (url === COUNTY) return Promise.resolve(PAGE);
  const path = url.slice(SOS.length + 1);
  return path in FEEDS
    ? Promise.resolve(JSON.stringify(FEEDS[path]))
    : Promise.reject(new Error("HTTP 500"));
};

Deno.test("the state's feeds parse into one count per contest, proposition, and judge", () => {
  const gov = parseSosFeed(FEEDS.governor, `${SOS}/governor`);
  assertEquals(gov[0].choices.map((c) => [c.name, c.votes, c.percent]), [
    ["Xavier Becerra", 4992161, 63.9],
    ["Steve Hilton", 2820000, 36.1],
  ]);
  assertEquals(gov[0].as_of, "November 4, 2026, 8:08 a.m.");
  const props = parseSosFeed(FEEDS["ballot-measures"], `${SOS}/ballot-measures`);
  assertEquals(props.map((p) => p.contest.split(":")[0]), ["Proposition 40", "Proposition 4"]);
  const judges = parseSosFeed(FEEDS["courts-of-appeal/district/4"], "u");
  assertStringIncludes(judges[0].contest, "Jose S. Castillo");
  assertEquals(parseSosFeed("not json", "u"), []);
});

Deno.test("the county's page parses each contest's table, its status, and its report, never a script", () => {
  const cs = parseCountyPage(PAGE, COUNTY, "San Bernardino County Registrar of Voters");
  assertEquals(cs.length, 5);
  const clerk = cs[1];
  assertEquals(clerk.contest, "City of Fontana City Clerk (Vote for 1)");
  assertEquals(clerk.choices.map((c) => c.votes), [12149, 10362, 6133]);
  assertEquals(clerk.status, "Final Unofficial Election Night Results");
  assertEquals(clerk.as_of, "Summary Report #5; next update November 5, 2026 By 6 p.m.");
  assertEquals(clerk.reporting, "70 of 70 (100.00%) precincts reported");
});

Deno.test("each state or district office goes to its feed; a city's treasurer never does", () => {
  assertEquals(sosPathFor("Governor", "State Offices"), "governor");
  assertEquals(sosPathFor("Treasurer", "State Offices"), "treasurer");
  assertEquals(sosPathFor("City Treasurer", "City of Fontana Offices"), null);
  assertEquals(sosPathFor("Treasurer", "City of Fontana Offices"), null);
  assertEquals(
    sosPathFor("United States Representative District 35", "Voter-Nominated"),
    "us-rep/district/35",
  );
  assertEquals(
    sosPathFor("Member of the State Assembly District 50", "x"),
    "state-assembly/district/50",
  );
  assertEquals(
    sosPathFor("Member, State Board of Equalization District 1", "State"),
    "board-of-equalization/district/1",
  );
  assertEquals(districtOf("Court of Appeal, Fourth District, Division One"), 4);
  assertEquals(districtOf("Court of Appeal 4th Appellate District"), 4);
  assertEquals(sosPaths(reading).sort(), [
    "ballot-measures",
    "courts-of-appeal/district/4",
    "governor",
    "secretary-of-state",
  ]);
});

Deno.test("names match without initials or nicknames; never by surname alone", () => {
  assertEquals(personKey("DONALD P. (DON) WAGNER"), personKey("Donald P. Wagner"));
  assertEquals(personKey("HERB W MORGAN"), personKey("Herb Morgan"));
  assertEquals(personKey(`ALEJANDRO "ALEX" VARA`), "alejandro vara");
  assert(personKey("Joe Smith") !== personKey("Jane Smith"));
});

Deno.test("every item gets the state's count, the county's, or a reason; choices kept in ballot order", async () => {
  const c = await checkResults(reading, fetcher(), new Date("2026-11-05T12:00:00Z"));
  const by = new Map(c.matched.map((m) => [m.item, m]));
  assertEquals(by.get("0")!.count.source, "state");
  // Secretary of State lists Wagner first; the ballot lists Weber first.
  const sos = by.get("1")!;
  assertEquals(sos.order.map((i) => sos.count.choices[i!].name), [
    "Shirley N. Weber",
    "Donald P. Wagner",
  ]);
  assertEquals(by.get("2")!.count.source, "county");
  assertEquals(by.get("m0")!.count.source, "state");
  assertEquals(by.get("m1")!.count.contest.startsWith("Proposition 40"), true);
  // Two places have a Measure I; the ballot's place decides.
  assertStringIncludes(by.get("m2")!.count.contest, "San Bernardino County");
  assertEquals(c.unmatched, [{
    item: "3",
    why: "no count on the county's page lists all of its candidates",
  }]);
  assertEquals(c.errors, []);
});

Deno.test("a statewide contest falls back to the county's count, marked as that county's only", async () => {
  const c = await checkResults(reading, fetcher(["/governor"]), new Date("2026-11-05T12:00:00Z"));
  const gov = c.matched.find((m) => m.item === "0")!;
  assertEquals([gov.count.source, gov.partial], ["county", true]);
  assertEquals(c.errors.length, 1);
  assertStringIncludes(
    standing({ ...gov, last_read: gov.read_at }, "2026-11-03", new Date()),
    "Only San Bernardino County",
  );
  // With both down, the item says why rather than going quiet.
  const none = await checkResults(reading, fetcher(["/governor", "results.rov"]), new Date());
  assertStringIncludes(none.unmatched.find((u) => u.item === "0")!.why, "couldn't be read");
});

Deno.test("two contests that both fit are neither's", () => {
  const twice: ContestCount = {
    source: "county",
    source_name: "c",
    source_url: "u",
    contest: "A",
    reporting: null,
    as_of: null,
    status: null,
    choices: [{ name: "GERMAINE KEY", votes: 1, percent: null }, {
      name: "JOE ALVANEZ",
      votes: 1,
      percent: null,
    }, { name: "DANIEL QUIROGA", votes: 1, percent: null }],
  };
  const { unmatched } = matchResults(reading, [], [twice, { ...twice, contest: "B" }], "t");
  assertEquals(
    unmatched.find((u) => u.item === "2")!.why,
    "more than one contest lists all of its candidates",
  );
});

Deno.test("only a ballot in its count window is checked on a schedule", () => {
  assert(!inCountWindow(reading, new Date("2026-11-02T12:00:00Z")));
  // Election day itself, before the polls close at 8 p.m. Pacific (04:00 UTC the next day).
  assert(!inCountWindow(reading, new Date("2026-11-03T20:00:00Z")));
  assert(inCountWindow(reading, new Date("2026-11-04T04:30:00Z")));
  assert(inCountWindow(reading, new Date("2026-11-04T12:00:00Z")));
  assert(inCountWindow(reading, new Date("2026-12-15T12:00:00Z")));
  assert(!inCountWindow(reading, new Date("2026-12-20T12:00:00Z")));
  assert(!inCountWindow({ ...reading, state: "NV" }, new Date("2026-11-04T12:00:00Z")));
});

Deno.test("a count is kept once; a changed one is new, and the older stays as history", async () => {
  const s = await openStores(await Deno.makeTempDir());
  await s.ballots.save({
    id: "ballot-1",
    status: "read",
    created_at: "2026-10-28T00:00:00Z",
    updated_at: "2026-10-28T00:00:00Z",
    error: null,
    pages: 1,
    reading,
    started: {},
  });
  let t = new Date("2026-11-04T12:00:00Z");
  let feeds = fetcher();
  const checker = new ResultsChecker(s.ballots, s.results, (u) => feeds(u), () => {}, () => t);
  const first = await checker.check("ballot-1");
  assertEquals(first.ok && first.changed, 6);
  assertEquals((await checker.due()).length, 0);
  // Asked again too soon: refused, nothing read.
  t = new Date("2026-11-04T12:02:00Z");
  assertEquals((await checker.check("ballot-1", true)).ok, false);
  // A day on, the same counts: nothing new; last read moves.
  t = new Date("2026-11-05T12:00:00Z");
  assertEquals(await checker.due(), ["ballot-1"]);
  const same = await checker.check("ballot-1");
  assertEquals(same.ok && same.changed, 0);
  const clerk = checker.forBallot("ballot-1").get("2")!;
  assertEquals(clerk.length, 1);
  assertEquals([clerk[0].read_at, clerk[0].last_read], [
    "2026-11-04T12:00:00.000Z",
    "2026-11-05T12:00:00.000Z",
  ]);
  // A new report with the same votes is the same count, not a new row.
  const relabeled = PAGE.replace("Summary Report #5", "Summary Report #6");
  feeds = (u) => u === COUNTY ? Promise.resolve(relabeled) : fetcher()(u);
  t = new Date("2026-11-05T18:00:00Z");
  const again = await checker.check("ballot-1");
  assertEquals(again.ok && again.changed, 0);
  // The county counts more ballots: a new count, the first kept below it.
  const later = PAGE.replace("12,149", "13,000").replace("Summary Report #5", "Summary Report #6");
  feeds = (u) => u === COUNTY ? Promise.resolve(later) : fetcher()(u);
  t = new Date("2026-11-06T12:00:00Z");
  await checker.check("ballot-1");
  const now = checker.forBallot("ballot-1").get("2")!;
  assertEquals(now.map((r) => r.count.choices[0].votes), [13000, 12149]);

  const html = resultBox(now, resultNames(reading, "2"), {
    picks: ["JOE ALVANEZ"],
    electionDate: "2026-11-03",
    now: t,
    resultsHref: "/ballots/ballot-1/results#item-2",
  });
  assertStringIncludes(html, "Earlier counts (1)");
  assertStringIncludes(html, "your pick");
  assertStringIncludes(html, "Unofficial until the county certifies, by Dec 3, 2026");
  assert(!/winner|won|leads|leading/i.test(html.replace("no winner is named here", "")));
  // Ballot order, not by votes: Key, Alvanez, Quiroga.
  assert(html.indexOf("GERMAINE KEY") < html.indexOf("JOE ALVANEZ"));
  assert(html.indexOf("JOE ALVANEZ") < html.indexOf("DANIEL QUIROGA"));
  s.db.close();
});

Deno.test("the Results tab lists every item, with a count or why not", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const b = {
    id: "ballot-2",
    status: "read" as const,
    created_at: "2026-10-28T00:00:00Z",
    updated_at: "2026-10-28T00:00:00Z",
    error: null,
    pages: 1,
    reading,
    started: {},
  };
  await s.ballots.save(b);
  const checker = new ResultsChecker(
    s.ballots,
    s.results,
    fetcher(),
    () => {},
    () => new Date("2026-11-05T00:00:00Z"),
  );
  await checker.check(b.id);
  const items = [
    ...reading.contests.map((c, i) => ({ key: String(i), heading: c.office })),
    ...reading.measures.map((_, i) => ({ key: `m${i}`, heading: `m${i}` })),
  ]
    .map((x) => ({
      ...x,
      detail: "",
      options: [],
      max: 1,
      run: null,
      choice: null,
      choiceId: `ballot-2-${x.key}`,
    }));
  const html = resultsPage(b, items, {
    results: checker.forBallot(b.id),
    lastCheck: checker.lastCheck(b.id),
    nextCheck: null,
    now: new Date("2026-11-05T00:00:00Z"),
  });
  assertStringIncludes(html, "6 of 7 with a count");
  assertStringIncludes(
    html,
    "No count yet: no count on the county&#39;s page lists all of its candidates",
  );
  assertStringIncludes(html, "Check for new results");
  assertStringIncludes(html, `aria-current="page">Results`);
  s.db.close();
});
