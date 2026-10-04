/**
 * The real web app, backed by placeholder research instead of Claude, so the
 * whole flow can be tried without an API key or spending anything.
 *
 *   deno task demo      # http://127.0.0.1:8788, data kept in a temp directory
 *
 * Whatever city you enter, results are the same labeled placeholders.
 */
import { JobRunner } from "../src/web/jobs.ts";
import { createApp } from "../src/web/server.ts";
import { RunStore } from "../src/web/store.ts";
import { samplePort } from "./sample_data.ts";

const store = new RunStore(await Deno.makeTempDir({ prefix: "ballotfix-demo-" }));
await store.init();
const jobs = new JobRunner(store, () => samplePort(3000));
const port = Number(Deno.env.get("PORT") ?? "8788");
Deno.serve({ hostname: "127.0.0.1", port }, createApp({ store, jobs, canResearch: true }));
