/**
 * Web app entry point.
 *
 *   deno task serve            # http://127.0.0.1:8787
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required to research (the app still opens saved races without it)
 *   HOST, PORT          listen address (default 127.0.0.1:8787)
 *   BALLOTFIX_PASSWORD  require this password (HTTP Basic auth, any username)
 *   BALLOTFIX_DATA_DIR  where runs are saved (default data)
 *   BALLOTFIX_MODEL, BALLOTFIX_EFFORT   research model and effort
 */

import { AnthropicResearcher } from "./research/anthropic.ts";
import { JobRunner } from "./web/jobs.ts";
import { createApp } from "./web/server.ts";
import { RunStore } from "./web/store.ts";

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
const canResearch = Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN"));

if (host !== "127.0.0.1" && host !== "localhost" && !password) {
  console.warn(
    `Listening on ${host} without BALLOTFIX_PASSWORD. Anyone who can reach this port can start paid research.`,
  );
}

const store = new RunStore(env("BALLOTFIX_DATA_DIR") ?? "data");
await store.init();
const interrupted = await store.markInterrupted(new Date().toISOString());
if (interrupted) console.log(`Marked ${interrupted} unfinished run(s) as interrupted.`);

const jobs = new JobRunner(
  store,
  () => new AnthropicResearcher({ model: env("BALLOTFIX_MODEL"), effort: effort as Effort }),
  { log: (m) => console.log(m) },
);

if (!canResearch) console.warn("ANTHROPIC_API_KEY is not set: research is disabled.");
Deno.serve({ hostname: host, port }, createApp({ store, jobs, canResearch, password }));
