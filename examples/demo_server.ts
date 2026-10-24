/**
 * The real web app, backed by placeholder research instead of Claude, so the
 * whole flow can be tried without an API key or spending anything.
 *
 *   deno task demo      # http://localhost:8788, password "demo", data in a temp directory
 *
 * Whatever city you enter, results are the same labeled placeholders. Sign-in
 * is on, with passkeys working at http://localhost:8788 (browsers treat
 * localhost as secure). Open it at localhost, not 127.0.0.1, for passkeys.
 */
import { Auth, expectedOriginFrom } from "../src/auth/auth.ts";
import { AuthStore } from "../src/auth/store.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { createApp } from "../src/web/server.ts";
import { RunStore } from "../src/web/store.ts";
import { samplePort } from "./sample_data.ts";

const dir = await Deno.makeTempDir({ prefix: "ballotfix-demo-" });
const store = new RunStore(dir);
await store.init();
const jobs = new JobRunner(store, () => samplePort(3000));
const port = Number(Deno.env.get("PORT") ?? "8788");
const baseUrl = `http://localhost:${port}`;
const authStore = new AuthStore(`${dir}/auth`);
await authStore.init();
const auth = new Auth(authStore, { password: "demo", expected: expectedOriginFrom(baseUrl) });
console.log(`Demo: open ${baseUrl} and sign in with the password "demo".`);
Deno.serve(
  { hostname: "127.0.0.1", port },
  createApp({ store, jobs, canResearch: true, auth, baseUrl }),
);
