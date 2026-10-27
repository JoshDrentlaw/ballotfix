import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { BallotJobs, JobRunner, QueueFullError } from "../src/web/jobs.ts";
import { createApp, parseRaceForm, sniffBallotType } from "../src/web/server.ts";
import { DEFAULT_FORM, MAX_BALLOT_FILE_BYTES } from "../src/web/pages.ts";
import { BallotStore, ChoiceStore, type RunRecord, RunStore } from "../src/web/store.ts";
import type {
  BallotCandidate,
  BallotPage,
  BallotReader,
  BallotReading,
  MeasureQuery,
  RaceQuery,
  RawCandidateResearch,
  RawMeasureResearch,
  ResearchPort,
} from "../src/types.ts";
import { listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true },
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
];

/** A research port whose candidate calls wait until released, so tests can observe "running". */
class GatedPort implements ResearchPort {
  #release!: () => void;
  readonly gate = new Promise<void>((r) => (this.#release = r));
  release() {
    this.#release();
  }
  findBallot() {
    return Promise.resolve(listing(CANDS));
  }
  async researchCandidate(_q: RaceQuery, c: BallotCandidate): Promise<RawCandidateResearch> {
    await this.gate;
    if (c.name === "Joz Sida") throw new Error("rate limited");
    return raw();
  }
  measures: MeasureQuery[] = [];
  async researchMeasure(m: MeasureQuery): Promise<RawMeasureResearch> {
    this.measures.push(m);
    await this.gate;
    return rawMeasure({
      official_title: "Fontana Parks Tax",
      sections: {
        effect: {
          facts: [{
            statement: "A yes vote adds a half-cent sales tax.",
            source_name: "City Attorney",
            source_url: "https://fontana.example/analysis",
            author: null,
            published: null,
            evidence_type: "primary_record",
          }],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: ["https://fontana.example/analysis"],
    });
  }
}

const READING: BallotReading = {
  election_date: "2026-11-03",
  state: "CA",
  county: "San Bernardino",
  contests: [
    { office: "Mayor", jurisdiction: "City of Fontana", vote_for: 1, candidates: CANDS },
    {
      office: "Member, City Council, District 2",
      jurisdiction: "City of Fontana",
      vote_for: 1,
      candidates: [{ name: "Pat Example", ballot_designation: "Teacher", incumbent: false }],
    },
    {
      office: "Member, Water Board",
      jurisdiction: "Example Water District",
      vote_for: 2,
      candidates: [],
    },
  ],
  measures: [
    {
      kind: "measure",
      label: "Measure X",
      jurisdiction: "City of Fontana",
      question: "Shall a half-cent sales tax for parks be adopted?",
      person: "",
    },
    {
      kind: "retention",
      label: "Associate Justice, Court of Appeal, Fourth District",
      jurisdiction: "State of California",
      question: "Shall Pat Judge be elected to the office for the term provided by law?",
      person: "Pat Judge",
    },
  ],
  notes: null,
  model: "fake",
};

/** A ballot reader that waits until released, and records what it was given. */
class GatedReader implements BallotReader {
  #release!: () => void;
  readonly gate = new Promise<void>((r) => (this.#release = r));
  pages: BallotPage[][] = [];
  release() {
    this.#release();
  }
  async readBallot(pages: BallotPage[]): Promise<BallotReading> {
    this.pages.push(pages);
    await this.gate;
    return READING;
  }
}

async function setup(
  opts: { password?: string; canResearch?: boolean; maxQueued?: number; basePath?: string } = {},
) {
  const dir = await Deno.makeTempDir();
  const store = new RunStore(dir);
  await store.init();
  const ballotStore = new BallotStore(dir);
  await ballotStore.init();
  const choices = new ChoiceStore(dir);
  await choices.init();
  const port = new GatedPort();
  const reader = new GatedReader();
  const jobs = new JobRunner(store, () => port, { maxQueued: opts.maxQueued });
  const ballots = new BallotJobs(ballotStore, () => reader);
  const app = createApp({
    store,
    jobs,
    ballots,
    choices,
    canResearch: opts.canResearch ?? true,
    password: opts.password,
    basePath: opts.basePath,
  });
  return { dir, store, ballotStore, choices, port, reader, jobs, ballots, app };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0]);

function upload(files: File[], headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const f of files) form.append("pages", f);
  return new Request("http://app.test/ballots", {
    method: "POST",
    body: form,
    headers: { origin: "http://app.test", ...headers },
  });
}

function postForm(path: string, entries: [string, string][]) {
  const form = new FormData();
  for (const [k, v] of entries) form.append(k, v);
  return new Request(`http://app.test${path}`, {
    method: "POST",
    body: form,
    headers: { origin: "http://app.test" },
  });
}

function post(path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`http://app.test${path}`, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { origin: "http://app.test", ...headers },
  });
}

/**
 * Waits, by state rather than a fixed delay (CI runners are slow), until the race at
 * `loc` reaches the gated candidate calls, i.e. its partial race has been saved.
 */
async function untilRunning(store: RunStore, loc: string) {
  const id = loc.split("/").pop()!;
  for (let i = 0; i < 500 && !(await store.get(id))?.race; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const FORM = { city: "Fontana", state: "ca", office: "Mayor", election: "2026-11-03" };

Deno.test("home page renders the form and a mobile viewport", async () => {
  const { app } = await setup();
  const res = await app(new Request("http://app.test/"));
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, `name="viewport" content="width=device-width, initial-scale=1"`);
  assertStringIncludes(body, `action="/races"`);
  assertEquals(res.headers.get("x-frame-options"), "DENY");
  assert(!/<script/i.test(body));
});

Deno.test("submitting a race redirects to it, shows progress, then the finished dossier", async () => {
  const { app, port, jobs, store } = await setup();
  const res = await app(post("/races", FORM));
  assertEquals(res.status, 303);
  const loc = res.headers.get("location")!;
  assertMatch(loc, /^\/races\/fontana-mayor-2026-11-03-\d{12}-[0-9a-f]{6}$/);

  await untilRunning(store, loc);
  const running = await (await app(new Request(`http://app.test${loc}`))).text();
  assertStringIncludes(running, `http-equiv="refresh" content="10"`);
  assertStringIncludes(running, "Researching now");
  assertStringIncludes(running, "0 of 2 candidates");

  port.release();
  await jobs.idle();
  const done = await (await app(new Request(`http://app.test${loc}`))).text();
  assert(!done.includes(`http-equiv="refresh"`), "finished page should not refresh");
  assertStringIncludes(done, "Acquanetta Warren");
  assertStringIncludes(done, "Research failed in this run");
  assertStringIncludes(done, "Download page");

  const run = (await store.list())[0];
  assertEquals(run.status, "done");
  assertEquals(run.query.state, "CA");
  assertEquals(run.race!.candidates.map((c) => c.status), ["ok", "failed"]);

  const dl = await app(new Request(`http://app.test${loc}/download`));
  assertEquals(
    dl.headers.get("content-disposition"),
    `attachment; filename="fontana-mayor-2026-11-03.html"`,
  );
});

// Regression: deployed behind Caddy's `handle_path /ballotfix*` (which strips the prefix
// before forwarding), every `/races/...` link and redirect the app emitted was root-absolute
// — the browser followed them straight to e.g. nucklehead/races/<id>, no `/ballotfix` prefix,
// which matched no Caddy route and rendered blank. Fixed by threading basePath through, with
// Caddy switched to `handle` (which preserves the prefix) to match. This test pins both the
// prefixed behavior and that unprefixed/direct access (no proxy in front) still works.
Deno.test("basePath prefixes every generated link and redirect, and still accepts unprefixed paths", async () => {
  const { app, port, jobs, store } = await setup({ basePath: "/ballotfix" });

  const home = await (await app(new Request("http://app.test/ballotfix/"))).text();
  assertStringIncludes(home, `action="/ballotfix/races"`);
  assertStringIncludes(home, `href="/ballotfix/"`);

  const res = await app(post("/ballotfix/races", FORM));
  assertEquals(res.status, 303);
  const loc = res.headers.get("location")!;
  assertMatch(loc, /^\/ballotfix\/races\/fontana-mayor-2026-11-03-\d{12}-[0-9a-f]{6}$/);

  await untilRunning(store, loc);
  const running = await (await app(new Request(`http://app.test${loc}`))).text();
  assertStringIncludes(running, "Researching now");

  port.release();
  await jobs.idle();
  const done = await (await app(new Request(`http://app.test${loc}`))).text();
  assertStringIncludes(done, `href="/ballotfix/races/${loc.split("/").pop()}/download"`);

  // Direct/unprefixed access (e.g. curl straight to the container) still works.
  const bareHome = await app(new Request("http://app.test/"));
  assertEquals(bareHome.status, 200);
  const bareHealth = await app(new Request("http://app.test/healthz"));
  assertEquals(bareHealth.status, 200);
  const prefixedHealth = await app(new Request("http://app.test/ballotfix/healthz"));
  assertEquals(prefixedHealth.status, 200);
});

Deno.test("form errors re-render with the user's values and a 400", async () => {
  const { app } = await setup();
  const res = await app(post("/races", { ...FORM, city: "Fontana", state: "California" }));
  assertEquals(res.status, 400);
  const body = await res.text();
  assertStringIncludes(body, "two-letter code");
  assertStringIncludes(body, `value="Fontana"`);
});

Deno.test("parseRaceForm validates candidates and the incumbent name", () => {
  const base = { ...DEFAULT_FORM, city: "Fontana" };
  assertEquals(parseRaceForm({ ...base, candidates: "A\nB\na" }).ok, false);
  assertEquals(parseRaceForm({ ...base, candidates: "A\nB", incumbent: "C" }).ok, false);
  const ok = parseRaceForm({ ...base, candidates: " A ;\n\nB", incumbent: "b" });
  assert(ok.ok);
  assertEquals(ok.candidates, [
    { name: "A", ballot_designation: null, incumbent: false },
    { name: "B", ballot_designation: null, incumbent: true },
  ]);
  const discover = parseRaceForm(base);
  assert(discover.ok);
  assertEquals(discover.candidates, null);
});

Deno.test("cross-site POSTs are refused before anything is started", async () => {
  const { app, store } = await setup();
  const evil = await app(post("/races", FORM, { origin: "https://evil.example" }));
  assertEquals(evil.status, 403);
  const fetchSite = await app(post("/races", FORM, { origin: "", "sec-fetch-site": "cross-site" }));
  assertEquals(fetchSite.status, 403);
  const nullOrigin = await app(post("/races", FORM, { origin: "null" }));
  assertEquals(nullOrigin.status, 403);
  assertEquals((await store.list()).length, 0);
});

Deno.test("a real browser's same-origin form post is accepted even with Origin: null", async () => {
  // Chromium sends Origin: null on form posts under some referrer policies;
  // Sec-Fetch-Site is what identifies them as the app's own.
  const { app, port, jobs } = await setup();
  const res = await app(post("/races", FORM, { origin: "null", "sec-fetch-site": "same-origin" }));
  assertEquals(res.status, 303);
  port.release();
  await jobs.idle();
});

Deno.test("password protects every page except the health check", async () => {
  const { app } = await setup({ password: "s3cret" });
  assertEquals((await app(new Request("http://app.test/"))).status, 401);
  assertEquals((await app(new Request("http://app.test/healthz"))).status, 200);
  const bad = new Request("http://app.test/", {
    headers: { authorization: `Basic ${btoa("me:nope")}` },
  });
  assertEquals((await app(bad)).status, 401);
  const good = new Request("http://app.test/", {
    headers: { authorization: `Basic ${btoa("me:s3cret")}` },
  });
  assertEquals((await app(good)).status, 200);
});

Deno.test("unknown and malformed run ids are 404s, never file paths", async () => {
  const { app } = await setup();
  for (const p of ["/races/nope", "/races/..%2F..%2Fetc%2Fpasswd", "/races/UPPER", "/races/a/b"]) {
    assertEquals((await app(new Request(`http://app.test${p}`))).status, 404, p);
  }
});

Deno.test("without an API key, research is disabled but the app still works", async () => {
  const { app } = await setup({ canResearch: false });
  const home = await (await app(new Request("http://app.test/"))).text();
  assertStringIncludes(home, "Research is off");
  assertStringIncludes(home, `type="submit" disabled`);
  assertEquals((await app(post("/races", FORM))).status, 503);
});

Deno.test("the queue refuses new races once full", async () => {
  const { jobs, port } = await setup({ maxQueued: 1 });
  await jobs.submit(QUERY, null);
  await jobs.submit(QUERY, null);
  let refused = false;
  try {
    await jobs.submit(QUERY, null);
  } catch (e) {
    refused = e instanceof QueueFullError;
  }
  assert(refused);
  port.release();
  await jobs.idle();
});

Deno.test("store marks unfinished runs interrupted on restart and skips corrupt files", async () => {
  const { dir, store } = await setup();
  const base: RunRecord = {
    id: "a-1",
    query: QUERY,
    candidates: null,
    status: "running",
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
    error: null,
    race: null,
  };
  await store.save(base);
  await store.save({ ...base, id: "b-2", status: "done", created_at: "2026-09-24T00:00:00Z" });
  await Deno.writeTextFile(`${dir}/c-3.json`, "{not json");
  assertEquals(await store.markInterrupted("2026-09-25T00:00:00Z"), 1);
  const runs = await store.list();
  assertEquals(runs.map((r) => [r.id, r.status]), [["b-2", "done"], ["a-1", "interrupted"]]);
});

Deno.test("home page offers a ballot upload that accepts photos and PDFs", async () => {
  const { app } = await setup();
  const body = await (await app(new Request("http://app.test/"))).text();
  assertStringIncludes(body, `action="/ballots" enctype="multipart/form-data"`);
  assertStringIncludes(body, `accept="image/jpeg,image/png,image/webp,application/pdf"`);
});

Deno.test("an uploaded ballot is read, reviewed, and the picked contest researched in ballot order", async () => {
  const { app, reader, ballots, ballotStore, store, port, jobs } = await setup();
  const res = await app(upload([new File([JPEG], "front.jpg", { type: "image/jpeg" })]));
  assertEquals(res.status, 303);
  const loc = res.headers.get("location")!;
  assertMatch(loc, /^\/ballots\/ballot-\d{12}-[0-9a-f]{6}$/);

  const reading = await (await app(new Request(`http://app.test${loc}`))).text();
  assertStringIncludes(reading, `http-equiv="refresh" content="5"`);
  // The type is from the bytes, and the bytes reach the reader untouched.
  assertEquals(reader.pages[0].map((p) => p.media_type), ["image/jpeg"]);
  assertEquals(reader.pages[0][0].data, JPEG);

  reader.release();
  await ballots.idle();
  const review = await (await app(new Request(`http://app.test${loc}`))).text();
  assert(!review.includes(`http-equiv="refresh"`));
  assertStringIncludes(review, "Member, City Council, District 2");
  assertStringIncludes(review, "Measure X");
  assertStringIncludes(review, `name="pick_measure" value="0"`);
  assertStringIncludes(review, "Research this judge");
  assertStringIncludes(review, "No candidate names could be read");
  assertStringIncludes(review, `name="pick" value="0"`);
  assert(!review.includes(`name="pick" value="2"`), "a contest with no names can't be picked");
  assert(!/<script/i.test(review));

  // Only the reading is saved: no image bytes on disk.
  const id = loc.split("/").pop()!;
  const saved = await Deno.readTextFile(`${ballotStore.dir}/${id}.json`);
  assert(!saved.includes("/9j/") && !saved.includes('"data"'));

  // Research the mayor's race, with a corrected spelling for one name.
  const go = await app(postForm(`${loc}/research`, [
    ["pick", "0"],
    ["election", "2026-11-03"],
    ["state", "CA"],
    ["office_0", "Mayor"],
    ["city_0", "City of Fontana"],
    ["candidates_0", "Acquanetta Warren\nJose Sida"],
    ["incumbent_0", "Acquanetta Warren"],
  ]));
  assertEquals(go.status, 303);
  assertMatch(go.headers.get("location")!, /^\/races\/city-of-fontana-mayor-2026-11-03-/);

  port.release();
  await jobs.idle();
  const run = (await store.list())[0];
  assertEquals(run.candidates, [
    { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true },
    // Renamed, so the designation read for the old spelling isn't carried over.
    { name: "Jose Sida", ballot_designation: null, incumbent: false },
  ]);
  // Edited, so the order is the user's, not confirmed as the ballot's (invariant 3).
  assertEquals(run.race!.listing.order_basis, "unofficial");
  assertEquals(run.race!.listing.source_name, "Your uploaded ballot, edited by you");

  const after = await (await app(new Request(`http://app.test${loc}`))).text();
  assert(!after.includes(`name="pick" value="0"`), "a started contest can't be started twice");
  // Started items move to their own tab.
  const researched = await (await app(new Request(`http://app.test${loc}/researched`))).text();
  assertStringIncludes(researched, `href="/races/${run.id}"`);

  // Rerunning keeps the edited-ballot source.
  const rerun = await app(post(`/races/${run.id}/rerun`, {}));
  assertEquals(rerun.status, 303);
  await jobs.idle();
  assertEquals(
    (await store.list())[0].race!.listing.source_name,
    "Your uploaded ballot, edited by you",
  );

  // A contest researched exactly as read keeps the ballot's order label.
  const asRead = await app(postForm(`${loc}/research`, [
    ["pick", "1"],
    ["election", "2026-11-03"],
    ["state", "CA"],
    ["office_1", "Member, City Council, District 2"],
    ["city_1", "City of Fontana"],
    ["candidates_1", "pat example"], // case differences aren't edits
  ]));
  assertEquals(asRead.status, 303);
  await jobs.idle();
  const council = (await store.list())[0];
  assertEquals(council.race!.listing.order_basis, "official_ballot_order");
  assertEquals(council.race!.listing.source_name, "Your uploaded ballot");
});

/** An uploaded, read ballot, ready for the review form. */
async function readBallot(s: Awaited<ReturnType<typeof setup>>) {
  const loc = (await s.app(upload([new File([JPEG], "a.jpg")]))).headers.get("location")!;
  s.reader.release();
  await s.ballots.idle();
  return loc;
}

const MAYOR: [string, string][] = [
  ["election", "2026-11-03"],
  ["state", "CA"],
  ["pick", "0"],
  ["office_0", "Mayor"],
  ["city_0", "City of Fontana"],
  ["candidates_0", "Acquanetta Warren\nJoz Sida"],
];

// Regression: two simultaneous posts (double-click, two tabs) both saw the contest
// unstarted and both started a paid race for it.
Deno.test("a double-submitted review form starts each contest once", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const [a, b] = await Promise.all([
    s.app(postForm(`${loc}/research`, MAYOR)),
    s.app(postForm(`${loc}/research`, MAYOR)),
  ]);
  assertEquals([a.status, b.status].sort(), [303, 409]);
  s.port.release();
  await s.jobs.idle();
  assertEquals((await s.store.list()).length, 1);
  // And once it's recorded, posting again is refused rather than repeated.
  const third = await s.app(postForm(`${loc}/research`, MAYOR));
  assertEquals(third.status, 400);
  assertEquals((await s.store.list()).length, 1);
});

// Regression: a non-queue error partway through left already-started races
// unrecorded, so the page offered them again and a retry paid twice.
Deno.test("races started before a failure are still recorded on the ballot", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const real = s.jobs.submit.bind(s.jobs);
  let calls = 0;
  s.jobs.submit = (...args: Parameters<typeof real>) =>
    ++calls === 2 ? Promise.reject(new Error("disk full")) : real(...args);
  const both: [string, string][] = [
    ...MAYOR,
    ["pick", "1"],
    ["office_1", "Member, City Council, District 2"],
    ["city_1", "City of Fontana"],
    ["candidates_1", "Pat Example"],
  ];
  await assertRejects(() => s.app(postForm(`${loc}/research`, both)), Error, "disk full");
  const saved = await s.ballotStore.get(loc.split("/").pop()!);
  assertEquals(Object.keys(saved!.started), ["0"]);
  s.port.release();
  await s.jobs.idle();
});

// Regression: when the queue filled partway, the page re-rendered without the
// user's corrections and with a stale "can be started" count.
Deno.test("a queue that fills partway keeps the user's edits and an honest count", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const real = s.jobs.submit.bind(s.jobs);
  let calls = 0;
  s.jobs.submit = (...args: Parameters<typeof real>) =>
    ++calls === 2 ? Promise.reject(new QueueFullError("queue is full")) : real(...args);
  const res = await s.app(postForm(`${loc}/research`, [
    ...MAYOR,
    ["pick", "1"],
    ["office_1", "Member, City Council, District 2"],
    ["city_1", "Fontana (corrected)"],
    ["candidates_1", "Pat Example"],
  ]));
  assertEquals(res.status, 429);
  const body = await res.text();
  assertStringIncludes(body, "queue is full");
  assertStringIncludes(body, `value="Fontana (corrected)"`);
  assertStringIncludes(body, `name="pick" value="1" checked`);
  assertStringIncludes(body, "up to 3 can start now");
  s.port.release();
  await s.jobs.idle();
});

// Regression: "1" and "01" deduped as different strings but meant the same
// contest, and "" became contest 0.
Deno.test("pick values must be plain contest numbers", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  for (const bad of [["0", "00"], ["0", "0e0"], [""], ["-1"], ["1.0"]]) {
    const res = await s.app(
      postForm(`${loc}/research`, [
        ...MAYOR.filter(([k]) => k !== "pick"),
        ...bad.map((v): [
          string,
          string,
        ] => ["pick", v]),
      ]),
    );
    assertEquals(res.status, 400, bad.join(","));
  }
  assertEquals((await s.store.list()).length, 0);
});

// Regression: only the first flagged incumbent survived in multi-seat contests,
// hiding the second one's incumbency (invariant 2).
Deno.test("multi-seat contests keep every incumbent", async () => {
  const two = parseRaceForm({
    ...DEFAULT_FORM,
    city: "Fontana",
    candidates: "A\nB\nC",
    incumbent: "a; C",
  });
  assert(two.ok);
  assertEquals(two.candidates!.map((c) => c.incumbent), [true, false, true]);
  assertEquals(
    parseRaceForm({ ...DEFAULT_FORM, city: "F", candidates: "A", incumbent: "A; Z" }).ok,
    false,
  );

  const s = await setup();
  const reading: BallotReading = {
    ...READING,
    contests: [{
      office: "Governing Board Member",
      jurisdiction: "Fontana Unified School District",
      vote_for: 3,
      candidates: [
        { name: "Ann One", ballot_designation: "Incumbent", incumbent: true },
        { name: "Bo Two", ballot_designation: "Parent", incumbent: false },
        { name: "Cy Three", ballot_designation: "Incumbent", incumbent: true },
      ],
    }],
  };
  s.reader.readBallot = () => Promise.resolve(reading);
  const loc = await readBallot(s);
  const review = await (await s.app(new Request(`http://app.test${loc}`))).text();
  assertStringIncludes(review, `name="incumbent_0" maxlength="300" value="Ann One; Cy Three"`);
});

Deno.test("an app without a ballot reader doesn't offer uploads", async () => {
  const dir = await Deno.makeTempDir();
  const store = new RunStore(dir);
  await store.init();
  const app = createApp({
    store,
    jobs: new JobRunner(store, () => new GatedPort()),
    canResearch: true,
  });
  const home = await (await app(new Request("http://app.test/"))).text();
  assert(!home.includes(`action="/ballots"`));
  assertStringIncludes(home, `action="/races"`);
});

Deno.test("uploads are refused before buffering when ballot reading is at capacity", async () => {
  const s = await setup();
  await s.app(upload([new File([JPEG], "a.jpg")]));
  await s.app(upload([new File([JPEG], "b.jpg")]));
  const third = await s.app(upload([new File([JPEG], "c.jpg")]));
  assertEquals(third.status, 429);
  assertStringIncludes(await third.text(), "Other ballots are being read");
  assertEquals(s.reader.pages.length, 2);
  s.reader.release();
  await s.ballots.idle();
});

Deno.test("ballot uploads are refused when they aren't a supported, reasonably sized file", async () => {
  const { app, reader } = await setup();
  const heic = await app(upload([new File([HEIC], "IMG_0001.HEIC", { type: "image/jpeg" })]));
  assertEquals(heic.status, 400);
  assertStringIncludes(await heic.text(), "Most Compatible");

  const text = await app(upload([new File(["hello"], "notes.txt", { type: "application/pdf" })]));
  assertEquals(text.status, 400);
  assertStringIncludes(await text.text(), "a JPEG, PNG, WebP, or PDF file");

  const big = new Uint8Array(MAX_BALLOT_FILE_BYTES + 1);
  big.set(JPEG);
  const tooBig = await app(upload([new File([big], "huge.jpg")]));
  assertEquals(tooBig.status, 400);
  assertStringIncludes(await tooBig.text(), "each file can be up to 7 MB");

  const four = Array.from(
    { length: 4 },
    (_, i) => new File([big.slice(0, 6 * 1024 * 1024)], `${i}.jpg`),
  );
  assertEquals((await app(upload(four))).status, 413);

  assertEquals((await app(upload([]))).status, 400);
  const evil = await app(upload([new File([JPEG], "a.jpg")], { origin: "https://evil.example" }));
  assertEquals(evil.status, 403);
  assertEquals(reader.pages.length, 0, "nothing was sent to be read");
});

Deno.test("the ballot review form needs a pick and respects the race queue", async () => {
  const { app, reader, ballots, port, jobs } = await setup({ maxQueued: 0 });
  const loc = (await app(upload([new File([JPEG], "a.jpg")]))).headers.get("location")!;
  reader.release();
  await ballots.idle();

  const none = await app(
    postForm(`${loc}/research`, [["election", "2026-11-03"], ["state", "CA"]]),
  );
  assertEquals(none.status, 400);
  assertStringIncludes(await none.text(), "Choose at least one contest");

  const fields = (i: number, names: string): [string, string][] => [
    ["pick", String(i)],
    [`office_${i}`, READING.contests[i].office],
    [`city_${i}`, "City of Fontana"],
    [`candidates_${i}`, names],
  ];
  const base: [string, string][] = [["election", "2026-11-03"], ["state", "CA"]];
  const two = await app(
    postForm(`${loc}/research`, [...base, ...fields(0, "A\nB"), ...fields(1, "Pat Example")]),
  );
  assertEquals(two.status, 400);
  const body = await two.text();
  assertStringIncludes(body, "Only 1 more race can be started");
  // The user's edits survive the error.
  assertStringIncludes(body, `name="pick" value="1" checked`);

  const emptied = await app(postForm(`${loc}/research`, [...base, ...fields(1, "")]));
  assertEquals(emptied.status, 400);
  assertStringIncludes(await emptied.text(), "list at least one candidate");

  port.release();
  await jobs.idle();
});

Deno.test("ballots still reading when the server stopped are marked interrupted", async () => {
  const { ballotStore } = await setup();
  await ballotStore.save({
    id: "ballot-1",
    status: "reading",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    pages: 2,
    reading: null,
    started: {},
  });
  assertEquals(await ballotStore.markInterrupted("2026-10-02T00:00:00Z"), 1);
  assertEquals((await ballotStore.get("ballot-1"))!.status, "interrupted");
});

Deno.test("sniffBallotType trusts bytes, not names", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assertEquals(sniffBallotType(JPEG), "image/jpeg");
  assertEquals(sniffBallotType(enc("%PDF-1.7\n")), "application/pdf");
  assertEquals(sniffBallotType(enc("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assertEquals(
    sniffBallotType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  assertEquals(sniffBallotType(HEIC), "heic");
  assertEquals(sniffBallotType(enc("<svg onload=alert(1)>")), null);
});

Deno.test("a measure and a judge picked from the ballot are researched, with the voter's issues", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const go = await s.app(postForm(`${loc}/research`, [
    ["election", "2026-11-03"],
    ["state", "CA"],
    ["pick_measure", "0"],
    ["mlabel_0", "Measure X"],
    ["mjur_0", "City of Fontana"],
    ["pick_measure", "1"],
    ["mlabel_1", "Associate Justice, Court of Appeal, Fourth District"],
    ["mjur_1", "State of California"],
    ["mperson_1", "Pat Judge"],
    ["priorities", "housing costs\n\nparks; Parks"],
  ]));
  assertEquals(go.status, 303);
  assertEquals(go.headers.get("location"), `${loc}/researched`);
  s.port.release();
  await s.jobs.idle();

  const runs = await s.store.list();
  const measure = runs.find((r) => r.measure)!;
  const judge = runs.find((r) => !r.measure)!;
  assertEquals(measure.status, "done");
  assertEquals(measure.priorities, ["housing costs", "parks"]);
  // The question read from the ballot goes along to identify the measure.
  assertEquals(s.port.measures[0].question, "Shall a half-cent sales tax for parks be adopted?");
  assertEquals(measure.measure_result!.sections.effect.facts.length, 1);
  assertEquals(measure.measure_result!.priorities.map((p) => p.issue), ["housing costs", "parks"]);

  // A retention question is a one-person race with the judge as the incumbent.
  assertEquals(judge.candidates, [{
    name: "Pat Judge",
    ballot_designation: null,
    incumbent: true,
  }]);
  assertEquals(judge.race!.listing.contest_kind, "retention");
  assertEquals(judge.race!.listing.order_basis, "official_ballot_order");
  assertEquals(judge.priorities, ["housing costs", "parks"]);

  const page = await (await s.app(new Request(`http://app.test/races/${measure.id}`))).text();
  assertStringIncludes(page, "Measure X · City of Fontana · Nov 3, 2026");
  assertStringIncludes(page, "A yes vote adds a half-cent sales tax.");
  assertStringIncludes(page, "Official title: Fontana Parks Tax");
  assertStringIncludes(page, `href="/races/${measure.id}/download"`);
  assertStringIncludes(page, "You asked about:</strong> housing costs; parks");
  const judgePage = await (await s.app(new Request(`http://app.test/races/${judge.id}`))).text();
  assertStringIncludes(judgePage, "yes/no retention question");

  const dl = await s.app(new Request(`http://app.test/races/${measure.id}/download`));
  assertEquals(dl.status, 200);
  assertStringIncludes(await dl.text(), "does not recommend a yes or no vote");

  // Both items are marked started, and a rerun keeps the measure and the issues.
  const review = await (await s.app(new Request(`http://app.test${loc}`))).text();
  assert(!review.includes(`name="pick_measure"`));
  const researched = await (await s.app(new Request(`http://app.test${loc}/researched`))).text();
  assertStringIncludes(researched, `href="/races/${measure.id}"`);
  await s.app(post(`/races/${measure.id}/rerun`, {}));
  await s.jobs.idle();
  const again = (await s.store.list())[0];
  assertEquals(again.measure?.label, "Measure X");
  assertEquals(again.priorities, ["housing costs", "parks"]);
});

Deno.test("a ballot saved before measures were researched still offers them, asking for the jurisdiction", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const id = loc.split("/").pop()!;
  const b = (await s.ballotStore.get(id))!;
  await s.ballotStore.save({
    ...b,
    reading: { ...b.reading!, measures: ["Measure X: parks tax"] },
  });
  const review = await (await s.app(new Request(`http://app.test${loc}`))).text();
  assertStringIncludes(review, `name="pick_measure" value="0"`);
  assertStringIncludes(review, `<details open><summary>Fix what was read`);

  const missing = await s.app(postForm(`${loc}/research`, [
    ["election", "2026-11-03"],
    ["state", "CA"],
    ["pick_measure", "0"],
    ["mlabel_0", "Measure X: parks tax"],
    ["mjur_0", ""],
  ]));
  assertEquals(missing.status, 400);
  assertStringIncludes(await missing.text(), "put it on the ballot");
  assertEquals(s.port.measures.length, 0);
});

Deno.test("issues are optional, but limited in number and length", async () => {
  const s = await setup();
  const tooMany = await s.app(post("/races", { ...FORM, priorities: "a\nb\nc\nd\ne\nf" }));
  assertEquals(tooMany.status, 400);
  assertStringIncludes(await tooMany.text(), "up to 5 issues");
  const tooLong = await s.app(post("/races", { ...FORM, priorities: "x".repeat(121) }));
  assertEquals(tooLong.status, 400);
  const ok = await s.app(post("/races", { ...FORM, priorities: "housing costs" }));
  assertEquals(ok.status, 303);
  assertEquals((await s.store.list())[0].priorities, ["housing costs"]);
  const none = await s.app(post("/races", FORM));
  assertEquals(none.status, 303);
  assertEquals((await s.store.list()).find((r) => !r.priorities)?.query.city, "Fontana");
  s.port.release();
  await s.jobs.idle();
});

Deno.test("measure pick values must be plain numbers of measures that exist", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  for (const v of ["01", "", "7"]) {
    const res = await s.app(postForm(`${loc}/research`, [
      ["election", "2026-11-03"],
      ["state", "CA"],
      ["pick_measure", v],
      ["mlabel_7", "Measure Z"],
      ["mjur_7", "City of Fontana"],
    ]));
    assertEquals(res.status, 400, v);
  }
  assertEquals((await s.store.list()).length, 0);
});

Deno.test("notes and a pick are saved apart from the run, kept on rerun, and listed on the picks sheet", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  await s.app(postForm(`${loc}/research`, [
    ...MAYOR,
    ["pick_measure", "0"],
    ["mlabel_0", "Measure X"],
    ["mjur_0", "City of Fontana"],
  ]));
  let runs = await s.store.list();
  const mayor = runs.find((r) => !r.measure)!;
  const measure = runs.find((r) => r.measure)!;
  assertEquals(mayor.ballot, { id: loc.split("/").pop()!, key: "0", vote_for: 1 });

  // While research runs, the page refreshes itself, so there's no form to lose typing in.
  const running = await (await s.app(new Request(`http://app.test/races/${mayor.id}`))).text();
  assertStringIncludes(running, "once research finishes");
  assert(!running.includes(`/choice"`));
  s.port.release();
  await s.jobs.idle();

  const page = await (await s.app(new Request(`http://app.test/races/${mayor.id}`))).text();
  assertStringIncludes(page, `action="/races/${mayor.id}/choice"`);
  assertStringIncludes(page, `type="radio" name="pick" value="Acquanetta Warren"`);

  // Only real options, and no more than the ballot says to vote for.
  const bogus = await s.app(postForm(`/races/${mayor.id}/choice`, [["pick", "Someone Else"]]));
  assertEquals(bogus.status, 400);
  const two = await s.app(postForm(`/races/${mayor.id}/choice`, [
    ["pick", "Acquanetta Warren"],
    ["pick", "Joz Sida"],
  ]));
  assertEquals(two.status, 400);

  const save = await s.app(postForm(`/races/${mayor.id}/choice`, [
    ["pick", "Joz Sida"],
    ["notes", "Check the <warehouse> vote again"],
  ]));
  assertEquals(save.status, 303);
  assertEquals(save.headers.get("location"), `/races/${mayor.id}?saved=1#mine`);
  await s.app(postForm(`/races/${measure.id}/choice`, [["pick", "No"]]));
  assertEquals(
    (await s.app(postForm(`/races/${measure.id}/choice`, [["pick", "Maybe"]]))).status,
    400,
  );

  // Never in downloads or the run's JSON.
  const dl = await (await s.app(new Request(`http://app.test/races/${mayor.id}/download`))).text();
  assert(!dl.includes("warehouse"));
  const json = await (await s.app(new Request(`http://app.test/races/${mayor.id}.json`))).text();
  assert(!json.includes("warehouse"));

  const sheet = await (await s.app(new Request(`http://app.test${loc}/picks`))).text();
  assertStringIncludes(sheet, "2 of 5 decided");
  assertStringIncludes(sheet, "Check the &lt;warehouse&gt; vote again");
  assert(
    sheet.indexOf("Joz Sida") < sheet.indexOf(">No<"),
    "ballot order: contests, then measures",
  );
  // Only decided items are listed; the rest are named at the bottom, linked to where to decide.
  assert(!sheet.includes(`name="pick_1"`));
  assertStringIncludes(sheet, "Still undecided (3)");
  assertStringIncludes(sheet, `href="${loc}#item-1">Member, City Council, District 2</a>`);

  // A rerun keeps the notes and pick, and the sheet follows the new run.
  await s.app(post(`/races/${mayor.id}/rerun`, {}));
  await s.jobs.idle();
  runs = await s.store.list();
  const rerun = runs[0];
  assert(rerun.id !== mayor.id);
  assertEquals(rerun.choice_id, `${loc.split("/").pop()}-0`);
  assertEquals(rerun.choice_id, mayor.choice_id);
  const again = await (await s.app(new Request(`http://app.test/races/${rerun.id}`))).text();
  assertStringIncludes(again, `value="Joz Sida" checked`);
  const b = (await s.ballotStore.get(loc.split("/").pop()!))!;
  assertEquals(b.started["0"], rerun.id);
});

Deno.test("each contest can add its own issues to the ballot-wide ones", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const res = await s.app(postForm(`${loc}/research`, [
    ...MAYOR,
    ["priorities", "housing costs"],
    ["priorities_0", "warehouses\nHousing costs"],
    ["pick_measure", "0"],
    ["mlabel_0", "Measure X"],
    ["mjur_0", "City of Fontana"],
  ]));
  assertEquals(res.status, 303);
  const runs = await s.store.list();
  assertEquals(runs.find((r) => !r.measure)!.priorities, ["housing costs", "warehouses"]);
  assertEquals(runs.find((r) => r.measure)!.priorities, ["housing costs"]);

  const tooMany = await s.app(postForm(`${loc}/research`, [
    ["election", "2026-11-03"],
    ["state", "CA"],
    ["pick", "1"],
    ["office_1", "Member, City Council, District 2"],
    ["city_1", "City of Fontana"],
    ["candidates_1", "Pat Example"],
    ["priorities", "a\nb\nc\nd\ne"],
    ["priorities_1", "f\ng\nh\ni"],
  ]));
  assertEquals(tooMany.status, 400);
  assertStringIncludes(await tooMany.text(), "up to 8 issues in all");
  s.port.release();
  await s.jobs.idle();
});

Deno.test("the picks sheet changes every pick and note in place, researched or not", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const sheet = await (await s.app(new Request(`http://app.test${loc}/picks`))).text();
  assertStringIncludes(sheet, "No picks yet.");
  assertStringIncludes(sheet, "Still undecided (5)");
  assertStringIncludes(sheet, `href="${loc}#item-m1">Pat Judge (retention)</a>`);
  assertStringIncludes(sheet, "Still undecided: Mayor;", "the printed sheet names them too");
  assert(!sheet.includes(`name="pick_0"`), "undecided items aren't on the sheet's form");

  // One bad item refuses the whole save and keeps what was typed.
  const bad = await s.app(postForm(`${loc}/picks?from=ballot`, [
    ["pick_0", "Acquanetta Warren"],
    ["notes_0", "Known quantity"],
    ["pick_m0", "Maybe"],
  ]));
  assertEquals(bad.status, 400);
  const badPage = await bad.text();
  assertStringIncludes(badPage, "Measure X: That pick isn&#39;t one of the choices");
  assertStringIncludes(badPage, "Known quantity");
  assertEquals(await s.choices.list(), []);
  const tooMany = await s.app(postForm(`${loc}/picks`, [
    ["pick_0", "Acquanetta Warren"],
    ["pick_0", "Joz Sida"],
  ]));
  assertEquals(tooMany.status, 400);

  const save = await s.app(postForm(`${loc}/picks`, [
    ["pick_0", "Acquanetta Warren"],
    ["notes_0", "Known quantity"],
    ["pick_m0", "No"],
  ]));
  assertEquals(save.status, 303);
  assertEquals(save.headers.get("location"), `${loc}/picks?saved=1`);
  assertEquals((await s.choices.list()).length, 2, "unchanged items aren't written");
  const after = await (await s.app(new Request(`http://app.test${loc}/picks?saved=1`))).text();
  assertStringIncludes(after, "2 of 5 decided");
  assertStringIncludes(after, `value="Acquanetta Warren" checked`);

  // Researching it later shows the same note on the research page, and the sheet
  // then edits that same record.
  await s.app(postForm(`${loc}/research`, MAYOR));
  s.port.release();
  await s.jobs.idle();
  const run = (await s.store.list())[0];
  const page = await (await s.app(new Request(`http://app.test/races/${run.id}`))).text();
  assertStringIncludes(page, "Known quantity");
  const fresh = await (await s.app(new Request(`http://app.test${loc}/picks`))).text();
  const seen = fresh.match(/name="seen_0" value="([^"]*)"/)![1];
  const seenM0 = fresh.match(/name="seen_m0" value="([^"]*)"/)![1];
  assert(seen && seenM0, "the sheet carries each item's version");
  // As a browser posts it: every item, including the measure left as it was.
  const edit = await s.app(postForm(`${loc}/picks`, [
    ["pick_0", "Joz Sida"],
    ["notes_0", "Changed my mind"],
    ["seen_0", seen],
    ["pick_m0", "No"],
    ["seen_m0", seenM0],
  ]));
  assertEquals(edit.status, 303);
  const again = await (await s.app(new Request(`http://app.test/races/${run.id}`))).text();
  assertStringIncludes(again, `value="Joz Sida" checked`);
  assertStringIncludes(again, "Changed my mind");

  // A sheet loaded before that edit can't write its older copy back over it.
  const stale = await s.app(postForm(`${loc}/picks`, [
    ["pick_0", "Acquanetta Warren"],
    ["notes_0", "Known quantity"],
    ["seen_0", seen],
    ["pick_m0", "Yes"],
    ["seen_m0", seenM0],
  ]));
  assertEquals(stale.status, 409);
  assertStringIncludes(await stale.text(), "changed somewhere else");
  const kept = await (await s.app(new Request(`http://app.test/races/${run.id}`))).text();
  assertStringIncludes(kept, "Changed my mind");
  // All or nothing: the measure in that same post wasn't saved either.
  assertEquals((await s.choices.get(`${loc.split("/").pop()}-m0`))!.picks, ["No"]);
});

Deno.test("a saved pick that is no longer listed survives saving the form", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const id = loc.split("/").pop()!;
  // Picked as read, then the name was corrected when research started.
  await s.choices.save({
    id: `${id}-0`,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    picks: ["Joz Sda"],
    notes: "",
  });
  await s.app(postForm(`${loc}/research`, MAYOR));
  s.port.release();
  await s.jobs.idle();
  const run = (await s.store.list())[0];
  const page = await (await s.app(new Request(`http://app.test/races/${run.id}`))).text();
  assertStringIncludes(page, `value="Joz Sda" checked`);
  await s.app(postForm(`/races/${run.id}/choice`, [["pick", "Joz Sda"], ["notes", "typo?"]]));
  assertEquals((await s.choices.get(`${id}-0`))!.picks, ["Joz Sda"]);
});

Deno.test("picks can be marked on the ballot page before anything is researched", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const id = loc.split("/").pop()!;
  const review = await (await s.app(new Request(`http://app.test${loc}`))).text();
  // Each card carries the candidates as pick options, with their designations.
  assertStringIncludes(review, `type="radio" name="pick_0" value="Acquanetta Warren"`);
  assertStringIncludes(review, `name="pick_m1" value="Yes"`);
  assertStringIncludes(review, `formaction="/ballots/${id}/picks?from=ballot" formnovalidate`);
  assertStringIncludes(review, `href="/ballots/${id}/picks"`, "the picks tab is always there");

  const save = await s.app(postForm(`${loc}/picks?from=ballot`, [
    ["pick", "1"], // A research checkbox: ignored by a save.
    ["pick_0", "Joz Sida"],
    ["seen_0", ""],
    ["notes_0", "Read the debate coverage"],
    ["pick_m0", ""],
    ["seen_m0", ""],
  ]));
  assertEquals(save.status, 303);
  assertEquals(save.headers.get("location"), `${loc}?saved=1`);
  assertEquals((await s.choices.get(`${id}-0`))!.picks, ["Joz Sida"]);
  assertEquals(await s.store.list(), [], "saving picks starts no research");
  const after = await (await s.app(new Request(`http://app.test${loc}?saved=1`))).text();
  assertStringIncludes(after, "Your pick: <strong>Joz Sida</strong>");
  assertStringIncludes(after, `value="Joz Sida" checked`);

  // An error comes back on the ballot page, keeping what was typed.
  const bad = await s.app(postForm(`${loc}/picks?from=ballot`, [
    ["pick_0", "Someone Else"],
    ["seen_0", (await s.choices.get(`${id}-0`))!.updated_at],
    ["notes_0", "typed this"],
  ]));
  assertEquals(bad.status, 400);
  const badPage = await bad.text();
  assertStringIncludes(badPage, "<title>Your ballot</title>");
  assertStringIncludes(badPage, "typed this");
});

Deno.test("a page posting only some items leaves the others' picks alone", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const id = loc.split("/").pop()!;
  await s.app(postForm(`${loc}/picks`, [["pick_m0", "No"], ["notes_m0", "too vague"]]));
  await s.app(postForm(`${loc}/picks`, [["pick_0", "Joz Sida"], ["seen_0", ""]]));
  const m0 = (await s.choices.get(`${id}-m0`))!;
  assertEquals([m0.picks, m0.notes], [["No"], "too vague"]);
});

Deno.test("picks typed on the ballot page are saved when research starts", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const id = loc.split("/").pop()!;
  const go = await s.app(postForm(`${loc}/research`, [
    ...MAYOR,
    ["pick_1", "Pat Example"],
    ["seen_1", ""],
  ]));
  assertEquals(go.status, 303);
  assertEquals((await s.choices.get(`${id}-1`))!.picks, ["Pat Example"]);

  // A bad pick refuses the whole post: nothing is started or saved.
  const bad = await s.app(postForm(`${loc}/research`, [
    ["election", "2026-11-03"],
    ["state", "CA"],
    ["pick_measure", "0"],
    ["mlabel_0", "Measure X"],
    ["mjur_0", "City of Fontana"],
    ["pick_m0", "Maybe"],
  ]));
  assertEquals(bad.status, 400);
  assertEquals((await s.store.list()).length, 1);
  assertEquals(await s.choices.get(`${id}-m0`), null);

  // Saved elsewhere since the page loaded: show the saved version, not the stale typing,
  // so resubmitting can't overwrite it.
  const stale = await s.app(postForm(`${loc}/research`, [
    ["election", "2026-11-03"],
    ["state", "CA"],
    ["pick_measure", "0"],
    ["mlabel_0", "Measure X"],
    ["mjur_0", "City of Fontana"],
    ["notes_m0", "typed before"],
    ["seen_m0", "2000-01-01T00:00:00.000Z"],
  ]));
  assertEquals(stale.status, 409);
  assert(!(await stale.text()).includes("typed before"));
  assertEquals((await s.store.list()).length, 1);
  s.port.release();
  await s.jobs.idle();
});

Deno.test("researched items get their own tab and can be read one after another", async () => {
  const s = await setup();
  const loc = await readBallot(s);
  const id = loc.split("/").pop()!;
  const go = await s.app(postForm(`${loc}/research`, [
    ...MAYOR,
    ["pick_measure", "0"],
    ["mlabel_0", "Measure X"],
    ["mjur_0", "City of Fontana"],
  ]));
  assertEquals(go.headers.get("location"), `${loc}/researched`);
  const running = await (await s.app(new Request(`http://app.test${loc}/researched`))).text();
  assertStringIncludes(running, `http-equiv="refresh" content="10"`);
  assertStringIncludes(running, "Researching now");
  s.port.release();
  await s.jobs.idle();

  const runs = await s.store.list();
  const mayor = runs.find((r) => !r.measure)!;
  const measure = runs.find((r) => r.measure)!;
  const tab = await (await s.app(new Request(`http://app.test${loc}/researched`))).text();
  assert(!tab.includes(`http-equiv="refresh"`));
  assert(tab.indexOf(">Mayor<") < tab.indexOf(">Measure X<"), "ballot order");
  assertStringIncludes(tab, `href="/races/${mayor.id}#acquanetta-warren"`);
  assertStringIncludes(tab, "Research failed for this candidate.");
  assertStringIncludes(tab, `Researched <span class="count">2</span>`);
  assertStringIncludes(tab, `To research <span class="count">3</span>`);

  // Each research page links to its neighbors in ballot order and back to the tab.
  const first = await (await s.app(new Request(`http://app.test/races/${mayor.id}`))).text();
  assertStringIncludes(first, `href="/ballots/${id}/researched#item-0">1 of 2</a>`);
  assertStringIncludes(first, `class="next" href="/races/${measure.id}"`);
  assert(!first.includes(`class="prev" href`));
  const second = await (await s.app(new Request(`http://app.test/races/${measure.id}`))).text();
  assertStringIncludes(second, `class="prev" href="/races/${mayor.id}"`);
  assertStringIncludes(second, "2 of 2");
  // The top bar leads back to the ballot instead of to a new race.
  assertStringIncludes(second, `<a href="/ballots/${id}/researched#item-m0">Your ballot</a></nav>`);
  // A race not started from a ballot has no walk.
  const plain = await s.app(post("/races", {
    city: "Fontana",
    state: "CA",
    office: "Mayor",
    election: "2026-11-03",
    candidates: "",
    incumbent: "",
  }));
  await s.jobs.idle();
  const solo = await (await s.app(new Request(`http://app.test${plain.headers.get("location")}`)))
    .text();
  assert(!solo.includes(`class="walk"`));
  assertStringIncludes(solo, `<a href="/#new">New race</a></nav>`);
});
