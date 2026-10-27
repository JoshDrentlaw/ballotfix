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
import { openStores } from "../src/web/store.ts";
import {
  sampleBallotReader,
  sampleContextWriter,
  sampleMerger,
  samplePort,
} from "./sample_data.ts";

const dir = await Deno.makeTempDir({ prefix: "ballotfix-demo-" });
const { runs: store, ballots: ballotStore, choices } = await openStores(dir);
const jobs = new JobRunner(store, () => samplePort(3000), {
  makeMerger: () => sampleMerger(1500),
  makeContextWriter: () => sampleContextWriter(1500),
});
const ballots = new BallotJobs(ballotStore, () => sampleBallotReader(3000));
const port = Number(Deno.env.get("PORT") ?? "8788");
Deno.serve(
  { hostname: "127.0.0.1", port },
  createApp({ store, jobs, ballots, choices, canResearch: true }),
);
