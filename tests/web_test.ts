import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { BallotJobs, JobRunner, QueueFullError } from "../src/web/jobs.ts";
import { createApp, parseRaceForm, sniffBallotType } from "../src/web/server.ts";
import { DEFAULT_FORM, MAX_BALLOT_FILE_BYTES } from "../src/web/pages.ts";
import { BallotStore, type RunRecord, RunStore } from "../src/web/store.ts";
import type {
  BallotCandidate,
  BallotPage,
  BallotReader,
  BallotReading,
  RaceQuery,
  RawCandidateResearch,
  ResearchPort,
} from "../src/types.ts";
import { listing, QUERY, raw } from "./fakes.ts";

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
  measures: ["Measure X: parks sales tax"],
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
  const port = new GatedPort();
  const reader = new GatedReader();
  const jobs = new JobRunner(store, () => port, { maxQueued: opts.maxQueued });
  const ballots = new BallotJobs(ballotStore, () => reader);
  const app = createApp({
    store,
    jobs,
    ballots,
    canResearch: opts.canResearch ?? true,
    password: opts.password,
    basePath: opts.basePath,
  });
  return { dir, store, ballotStore, port, reader, jobs, ballots, app };
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

  // Let the job reach the gated candidate calls.
  await new Promise((r) => setTimeout(r, 20));
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
  const { app, port, jobs } = await setup({ basePath: "/ballotfix" });

  const home = await (await app(new Request("http://app.test/ballotfix/"))).text();
  assertStringIncludes(home, `action="/ballotfix/races"`);
  assertStringIncludes(home, `href="/ballotfix/"`);

  const res = await app(post("/ballotfix/races", FORM));
  assertEquals(res.status, 303);
  const loc = res.headers.get("location")!;
  assertMatch(loc, /^\/ballotfix\/races\/fontana-mayor-2026-11-03-\d{12}-[0-9a-f]{6}$/);

  await new Promise((r) => setTimeout(r, 20));
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
  assertStringIncludes(review, "Measure X: parks sales tax");
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
  assertEquals(run.race!.listing.order_basis, "official_ballot_order");
  assertEquals(run.race!.listing.source_name, "Your uploaded ballot");

  const after = await (await app(new Request(`http://app.test${loc}`))).text();
  assertStringIncludes(after, `href="/races/${run.id}"`);
  assert(!after.includes(`name="pick" value="0"`), "a started contest can't be started twice");

  // Rerunning keeps the ballot as the source.
  const rerun = await app(post(`/races/${run.id}/rerun`, {}));
  assertEquals(rerun.status, 303);
  await jobs.idle();
  const again = (await store.list())[0];
  assertEquals(again.race!.listing.order_basis, "official_ballot_order");
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
