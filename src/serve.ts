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
 *   BALLOTFIX_MODEL, BALLOTFIX_EFFORT   research model and effort
 *   BALLOTFIX_MERGE_MODEL  model for the one low-effort call per finished run that merges
 *                        duplicate claims (default: the research model); "off" skips it
 *   BALLOTFIX_CONTEXT_MODEL  model for the one low-effort call per finished run that writes
 *                        short sourced notes on names in the facts, with a few capped web
 *                        searches (default: the research model); "off" skips it
 *   BALLOTFIX_FINANCE_MODEL  model for the one low-effort call per finished run that reads
 *                        contributions off campaign finance filings, with capped web searches
 *                        and fetches (default: the research model); "off" skips it
 */

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
if (interrupted) console.log(`Marked ${interrupted} unfinished run(s) as interrupted.`);
await ballotStore.markInterrupted(now);

const researcher = () =>
  new AnthropicResearcher({ model: env("BALLOTFIX_MODEL"), effort: effort as Effort });
const mergeModel = env("BALLOTFIX_MERGE_MODEL");
const merger = () =>
  new AnthropicResearcher({ model: env("BALLOTFIX_MODEL"), mergeModel, effort: effort as Effort });
const contextModel = env("BALLOTFIX_CONTEXT_MODEL");
const contextWriter = () =>
  new AnthropicResearcher({
    model: env("BALLOTFIX_MODEL"),
    contextModel,
    effort: effort as Effort,
  });
const financeModel = env("BALLOTFIX_FINANCE_MODEL");
const financeResearcher = () =>
  new AnthropicResearcher({
    model: env("BALLOTFIX_MODEL"),
    financeModel,
    effort: effort as Effort,
  });
const jobs = new JobRunner(store, researcher, {
  log: (m) => console.log(m),
  makeMerger: mergeModel === "off" ? undefined : merger,
  makeContextWriter: contextModel === "off" ? undefined : contextWriter,
  makeFinanceResearcher: financeModel === "off" ? undefined : financeResearcher,
});
const ballots = new BallotJobs(ballotStore, researcher, { log: (m) => console.log(m) });

if (!canResearch) console.warn("ANTHROPIC_API_KEY is not set: research is disabled.");
Deno.serve(
  { hostname: host, port },
  createApp({ store, jobs, ballots, choices, canResearch, password, basePath }),
);
