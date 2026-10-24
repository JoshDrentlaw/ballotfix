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
 *   BALLOTFIX_PASSWORD  turn sign-in on: this password, or a passkey registered from
 *                        the Account page, starts a session
 *   BALLOTFIX_BASE_URL  the https:// origin people open the app at, e.g.
 *                        "https://host.example.ts.net". Passkeys are bound to its
 *                        hostname and stay off without it (HTTPS or localhost only).
 *   BALLOTFIX_DATA_DIR  where runs are saved (default data)
 *   BALLOTFIX_MODEL, BALLOTFIX_EFFORT   research model and effort
 */

import { Auth, expectedOriginFrom } from "./auth/auth.ts";
import { AuthStore } from "./auth/store.ts";
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
const basePath = env("BASE_PATH");
if (basePath && !basePath.startsWith("/")) {
  throw new Error(`BASE_PATH must start with "/" (got ${JSON.stringify(basePath)})`);
}
const baseUrl = env("BALLOTFIX_BASE_URL");
if (baseUrl) {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`BALLOTFIX_BASE_URL must be a URL (got ${JSON.stringify(baseUrl)})`);
  }
  if (parsed.origin !== baseUrl.replace(/\/+$/, "")) {
    throw new Error(
      `BALLOTFIX_BASE_URL must be just the origin, like https://host.example (got ${baseUrl}); ` +
        "the path prefix goes in BASE_PATH",
    );
  }
}
const canResearch = Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN"));

if (host !== "127.0.0.1" && host !== "localhost" && !password) {
  console.warn(
    `Listening on ${host} without BALLOTFIX_PASSWORD. Anyone who can reach this port can start paid research.`,
  );
}

const dataDir = env("BALLOTFIX_DATA_DIR") ?? "data";
const store = new RunStore(dataDir);
await store.init();

let auth: Auth | undefined;
if (password) {
  const authStore = new AuthStore(`${dataDir}/auth`);
  await authStore.init();
  const expected = expectedOriginFrom(baseUrl);
  auth = new Auth(authStore, { password, expected });
  console.log(
    expected
      ? `Sign-in is on. Passkeys work at ${expected.origin}.`
      : baseUrl
      ? `Sign-in is on (password only): ${baseUrl} isn't HTTPS, and browsers require it for passkeys.`
      : "Sign-in is on (password only). Set BALLOTFIX_BASE_URL to an https:// origin for passkeys.",
  );
}
const interrupted = await store.markInterrupted(new Date().toISOString());
if (interrupted) console.log(`Marked ${interrupted} unfinished run(s) as interrupted.`);

const jobs = new JobRunner(
  store,
  () => new AnthropicResearcher({ model: env("BALLOTFIX_MODEL"), effort: effort as Effort }),
  { log: (m) => console.log(m) },
);

if (!canResearch) console.warn("ANTHROPIC_API_KEY is not set: research is disabled.");
Deno.serve(
  { hostname: host, port },
  createApp({ store, jobs, canResearch, auth, baseUrl, basePath }),
);
