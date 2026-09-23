import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { JobRunner, QueueFullError } from "../src/web/jobs.ts";
import { createApp, parseRaceForm } from "../src/web/server.ts";
import { DEFAULT_FORM } from "../src/web/pages.ts";
import { type RunRecord, RunStore } from "../src/web/store.ts";
import type {
  BallotCandidate,
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

async function setup(opts: { password?: string; canResearch?: boolean; maxQueued?: number } = {}) {
  const dir = await Deno.makeTempDir();
  const store = new RunStore(dir);
  await store.init();
  const port = new GatedPort();
  const jobs = new JobRunner(store, () => port, { maxQueued: opts.maxQueued });
  const app = createApp({
    store,
    jobs,
    canResearch: opts.canResearch ?? true,
    password: opts.password,
  });
  return { dir, store, port, jobs, app };
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
