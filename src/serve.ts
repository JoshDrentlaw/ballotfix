/**
 * Web app entry point.
 *
 *   deno task serve            # http://127.0.0.1:8787
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required to research (the app still opens saved races without it)
 *   HOST, PORT          listen address (default 127.0.0.1:8787)
 *   BASE_PATH           mount prefix behind a Caddy `handle` block, e.g. "/ballotfix"
 *                        (see tower-expert's main.ts for the same convention). Requests
 *                        work with or without it, so direct access is unaffected.
 *   BALLOTFIX_PASSWORD  require this password (HTTP Basic auth, any username)
 *   BALLOTFIX_DATA_DIR  where ballotfix.db is kept (default data): runs, ballot readings,
 *                        the voter's notes and picks, and the knowledge graph
 *   BALLOTFIX_MODEL, BALLOTFIX_EFFORT   research model (default claude-opus-5-5) and effort
 *   BALLOTFIX_MERGE_MODEL  model for the one low-effort call per finished run that merges
 *                        duplicate claims (default: claude-haiku-5-5); "off" skips it
 *   BALLOTFIX_CONTEXT_MODEL  model for the one low-effort call per finished run that writes
 *                        short sourced notes on names in the facts, with a few capped web
 *                        searches (default: claude-sonnet-5-5); "off" skips it
 *   BALLOTFIX_FINANCE_MODEL  model for the one low-effort call per finished run that reads
 *                        contributions off campaign finance filings, with capped web searches
 *                        and fetches (default: claude-sonnet-5-5); "off" skips it
 *   BALLOTFIX_NETFILE   "off" always uses the model for campaign finance; otherwise, where
 *                        a California place's filings are on NetFile, contributions come
 *                        straight from its public export (netfile.com), the model elsewhere
 *   BALLOTFIX_NETFILE_AGENCIES  places whose NetFile agency is set by hand, e.g.
 *                        "Oakland=COAK; San Francisco=SFO"; others are found in NetFile's list
 *   BALLOTFIX_OFFICE_MODEL  model for the one capped lookup of what a race's office can do
 *                        (reused by later runs for the same office and place) and the call
 *                        marking the voter's issues against it (default: claude-sonnet-5-5);
 *                        "off" skips it
 *   BALLOTFIX_SHARED_MODEL  model for the one capped call per race, before any candidate,
 *                        that finds pages covering every candidate (voter guide, questionnaires,
 *                        forums) to put first in each one's research (default: claude-sonnet-5-5);
 *                        "off" skips it
 *   BALLOTFIX_MAX_QUEUED  races allowed to wait behind the running one (default 30); waiting
 *                        races are saved and put back in line after a restart
 *
 * Every model call logs one "[usage]" line: tokens, searches, and an estimated cost.
 */

import { NetFileClient, NetFileResearcher, parseAgencyMap } from "./netfile.ts";
import { AnthropicResearcher } from "./research/anthropic.ts";
import { BallotJobs, JobRunner } from "./web/jobs.ts";
import { createApp } from "./web/server.ts";
import { openStores } from "./web/store.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = typeof EFFORTS[number];

const env = (k: string) => Deno.env.get(k)?.trim() || undefined;
const host = env("HOST") ?? "127.0.0.1";
const port = Number(env("PORT") ?? "8787");
const password = env("BALLOTFIX_PASSWORD");
const effort = env("BALLOTFIX_EFFORT") ?? "high";
if (!(EFFORTS as readonly string[]).includes(effort)) {
  throw new Error(`BALLOTFIX_EFFORT must be one of ${EFFORTS.join(", ")}`);
}
const basePath = env("BASE_PATH");
if (basePath && !basePath.startsWith("/")) {
  throw new Error(`BASE_PATH must start with "/" (got ${JSON.stringify(basePath)})`);
}
const canResearch = Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN"));

if (host !== "127.0.0.1" && host !== "localhost" && !password) {
  console.warn(
    `Listening on ${host} without BALLOTFIX_PASSWORD. Anyone who can reach this port can start paid research.`,
  );
}

const dataDir = env("BALLOTFIX_DATA_DIR") ?? "data";
const { runs: store, ballots: ballotStore, choices } = await openStores(dataDir, {
  log: (m) => console.log(m),
});
const now = new Date().toISOString();
const interrupted = await store.markInterrupted(now);
if (interrupted) console.log(`Marked ${interrupted} run(s) cut off mid-research as interrupted.`);
await ballotStore.markInterrupted(now);

const log = (m: string) => console.log(m);
const researcher = () =>
  new AnthropicResearcher({ model: env("BALLOTFIX_MODEL"), effort: effort as Effort, log });
const mergeModel = env("BALLOTFIX_MERGE_MODEL");
const merger = () =>
  new AnthropicResearcher({
    model: env("BALLOTFIX_MODEL"),
    mergeModel,
    effort: effort as Effort,
    log,
  });
const contextModel = env("BALLOTFIX_CONTEXT_MODEL");
const contextWriter = () =>
  new AnthropicResearcher({
    model: env("BALLOTFIX_MODEL"),
    contextModel,
    effort: effort as Effort,
    log,
  });
const financeModel = env("BALLOTFIX_FINANCE_MODEL");
const modelFinance = () =>
  new AnthropicResearcher({
    model: env("BALLOTFIX_MODEL"),
    financeModel,
    effort: effort as Effort,
    log,
  });
// One client, so NetFile's agency list is read once while the app runs.
const netfile = env("BALLOTFIX_NETFILE") === "off" ? null : new NetFileClient();
const netfileAgencies = parseAgencyMap(env("BALLOTFIX_NETFILE_AGENCIES"));
const financeResearcher = () =>
  netfile
    ? new NetFileResearcher({
      source: netfile,
      fallback: modelFinance(),
      agencies: netfileAgencies,
      log,
    })
    : modelFinance();
const officeModel = env("BALLOTFIX_OFFICE_MODEL");
const officeResearcher = () =>
  new AnthropicResearcher({
    model: env("BALLOTFIX_MODEL"),
    officeModel,
    effort: effort as Effort,
    log,
  });
const sharedModel = env("BALLOTFIX_SHARED_MODEL");
const sharedFinder = () =>
  new AnthropicResearcher({
    model: env("BALLOTFIX_MODEL"),
    sharedModel,
    effort: effort as Effort,
    log,
  });
const maxQueued = env("BALLOTFIX_MAX_QUEUED");
if (maxQueued !== undefined && !/^\d+$/.test(maxQueued)) {
  throw new Error("BALLOTFIX_MAX_QUEUED must be a whole number");
}
const jobs = new JobRunner(store, researcher, {
  log: (m) => console.log(m),
  ...(maxQueued !== undefined ? { maxQueued: Number(maxQueued) } : {}),
  makeMerger: mergeModel === "off" ? undefined : merger,
  makeContextWriter: contextModel === "off" ? undefined : contextWriter,
  makeFinanceResearcher: financeModel === "off" ? undefined : financeResearcher,
  makeOfficeResearcher: officeModel === "off" ? undefined : officeResearcher,
  makeSharedFinder: sharedModel === "off" ? undefined : sharedFinder,
});
const ballots = new BallotJobs(ballotStore, researcher, { log: (m) => console.log(m) });
// Runs that were waiting when the server stopped never started: back in line, in order,
// unless research is off or they have waited more than a day (then marked interrupted).
const resumed = await jobs.resumeWaiting(canResearch);
if (resumed.resumed) console.log(`Put ${resumed.resumed} waiting run(s) back in the queue.`);
if (resumed.interrupted) {
  console.log(`Marked ${resumed.interrupted} waiting run(s) as interrupted instead.`);
}

if (!canResearch) console.warn("ANTHROPIC_API_KEY is not set: research is disabled.");
Deno.serve(
  { hostname: host, port },
  createApp({ store, jobs, ballots, choices, canResearch, password, basePath }),
);
