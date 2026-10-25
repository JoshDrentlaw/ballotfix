/**
 * The real web app, backed by placeholder research instead of Claude, so the
 * whole flow can be tried without an API key or spending anything.
 *
 *   deno task demo      # http://127.0.0.1:8788, data kept in a temp directory
 *
 * Whatever city you enter or ballot you upload, results are the same labeled placeholders.
 */
import { BallotJobs, JobRunner } from "../src/web/jobs.ts";
import { createApp } from "../src/web/server.ts";
import { BallotStore, RunStore } from "../src/web/store.ts";
import { sampleBallotReader, samplePort } from "./sample_data.ts";

const dir = await Deno.makeTempDir({ prefix: "ballotfix-demo-" });
const store = new RunStore(dir);
await store.init();
const ballotStore = new BallotStore(dir);
await ballotStore.init();
const jobs = new JobRunner(store, () => samplePort(3000));
const ballots = new BallotJobs(ballotStore, () => sampleBallotReader(3000));
const port = Number(Deno.env.get("PORT") ?? "8788");
Deno.serve(
  { hostname: "127.0.0.1", port },
  createApp({ store, jobs, ballots, canResearch: true }),
);
