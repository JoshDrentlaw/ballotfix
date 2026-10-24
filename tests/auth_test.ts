/**
 * Sign-in: the session gate, the password and passkey routes, and the
 * account page. The passkey ceremony itself is covered by webauthn_test.ts
 * against real browser payloads; here it's the plumbing around it.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  Auth,
  backoffForFailureCount,
  expectedOriginFrom,
  IDLE_TIMEOUT_MS,
} from "../src/auth/auth.ts";
import { AuthStore } from "../src/auth/store.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { createApp } from "../src/web/server.ts";
import { RunStore } from "../src/web/store.ts";
import { listing, raw } from "./fakes.ts";

const PASSWORD = "correct horse battery";

async function setup(opts: { baseUrl?: string; basePath?: string; now?: () => Date } = {}) {
  const dir = await Deno.makeTempDir();
  const store = new RunStore(dir);
  await store.init();
  const authStore = new AuthStore(`${dir}/auth`);
  await authStore.init();
  const auth = new Auth(authStore, {
    password: PASSWORD,
    expected: expectedOriginFrom(opts.baseUrl),
    now: opts.now,
  });
  const port = {
    findBallot: () => Promise.resolve(listing([])),
    researchCandidate: () => Promise.resolve(raw()),
  };
  const jobs = new JobRunner(store, () => port);
  const app = createApp({
    store,
    jobs,
    canResearch: true,
    auth,
    baseUrl: opts.baseUrl,
    basePath: opts.basePath,
  });
  return { dir, store, auth, authStore, app };
}

const SAME_ORIGIN = { origin: "http://app.test", "sec-fetch-site": "same-origin" };

function form(path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`http://app.test${path}`, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { ...SAME_ORIGIN, ...headers },
  });
}

function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://app.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...SAME_ORIGIN, "content-type": "application/json", ...headers },
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://app.test${path}`, { headers });
}

/** The `name=value` part of a Set-Cookie header, ready to send back. */
function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0];
}

async function signIn(app: (r: Request) => Promise<Response>): Promise<string> {
  const res = await app(form("/login", { password: PASSWORD, next: "/" }));
  assertEquals(res.status, 303);
  return cookieFrom(res);
}

Deno.test("every page needs a session except the health check, sign-in and its script", async () => {
  const { app } = await setup();
  const home = await app(get("/races/x?y=1"));
  assertEquals(home.status, 303);
  assertEquals(home.headers.get("location"), `/login?next=${encodeURIComponent("/races/x?y=1")}`);
  assertEquals((await app(form("/races", { city: "Fontana" }))).status, 401);
  assertEquals((await app(get("/account"))).status, 303);
  assertEquals((await app(get("/healthz"))).status, 200);
  assertEquals((await app(get("/login"))).status, 200);
  assertEquals((await app(get("/static/webauthn.js"))).status, 200);
});

Deno.test("the password starts a session with a hardened cookie, and only the hash is stored", async () => {
  const { app, authStore } = await setup({ baseUrl: "https://ballot.example.ts.net" });
  const res = await app(form("/login", { password: PASSWORD, next: "/races/abc" }));
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/races/abc");
  const set = res.headers.get("set-cookie") ?? "";
  for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/", "Secure"]) {
    assertStringIncludes(set, flag);
  }
  const token = cookieFrom(res).split("=")[1];
  assert(token.length >= 40);
  const saved = JSON.stringify(authStore.state);
  assert(!saved.includes(token), "the raw token must never be written to disk");

  const home = await app(get("/", { cookie: cookieFrom(res) }));
  assertEquals(home.status, 200);
  assertStringIncludes(await home.text(), `href="/account"`);
});

Deno.test("over plain HTTP the cookie isn't Secure, or the browser would drop it", async () => {
  const { app } = await setup();
  const res = await app(form("/login", { password: PASSWORD }));
  assert(!(res.headers.get("set-cookie") ?? "").includes("Secure"));
});

Deno.test("a wrong password is refused, and repeated failures back off", async () => {
  const { app } = await setup();
  for (let i = 0; i < 4; i++) {
    const res = await app(form("/login", { password: "nope" }));
    assertEquals(res.status, 401);
    assertStringIncludes(await res.text(), "isn&#39;t right");
  }
  // Four failures: past the free attempts, so even the right password waits.
  const locked = await app(form("/login", { password: PASSWORD }));
  assertEquals(locked.status, 429);
  assertStringIncludes(await locked.text(), "Too many attempts");
  // Passkey sign-in shares the same backoff.
  assertEquals((await app(jsonPost("/login/passkey/options", {}))).status, 429);

  assertEquals(backoffForFailureCount(3), 0);
  assertEquals(backoffForFailureCount(4), 5_000);
  assertEquals(backoffForFailureCount(50), 60 * 60_000);
});

Deno.test("after sign-in, only app paths are valid destinations", async () => {
  const { app } = await setup({ basePath: "/ballotfix" });
  for (
    const next of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:x"]
  ) {
    const res = await app(form("/ballotfix/login", { password: PASSWORD, next }));
    assertEquals(res.headers.get("location"), "/ballotfix/", next);
  }
  const ok = await app(
    form("/ballotfix/login", { password: PASSWORD, next: "/ballotfix/races/a" }),
  );
  assertEquals(ok.headers.get("location"), "/ballotfix/races/a");
});

Deno.test("signing out ends this session; signing out everywhere ends all of them", async () => {
  const { app, auth } = await setup();
  const a = await signIn(app);
  const b = await signIn(app);
  assertEquals(auth.sessionCount(), 2);

  const out = await app(form("/logout", {}, { cookie: a }));
  assertEquals(out.status, 303);
  assertMatch(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assertEquals((await app(get("/", { cookie: a }))).status, 303);
  assertEquals((await app(get("/", { cookie: b }))).status, 200);

  await app(form("/account/sign-out-everywhere", {}, { cookie: b }));
  assertEquals(auth.sessionCount(), 0);
  assertEquals((await app(get("/", { cookie: b }))).status, 303);
});

Deno.test("an idle session expires", async () => {
  let now = new Date("2026-10-01T00:00:00Z");
  const { app } = await setup({ now: () => now });
  const c = await signIn(app);
  assertEquals((await app(get("/", { cookie: c }))).status, 200);
  now = new Date(now.getTime() + IDLE_TIMEOUT_MS + 1);
  assertEquals((await app(get("/", { cookie: c }))).status, 303);
});

Deno.test("sessions survive a restart, because they live in the data directory", async () => {
  const { app, dir } = await setup();
  const c = await signIn(app);
  const reloaded = new AuthStore(`${dir}/auth`);
  await reloaded.init();
  assertEquals(reloaded.state.sessions.length, 1);
  // ...and the auth subdirectory is never mistaken for a run.
  assertEquals((await new RunStore(dir).list()).length, 0);
  assert(c);
});

Deno.test("cross-site posts to the sign-in routes are refused", async () => {
  const { app } = await setup({ baseUrl: "https://ballot.example.ts.net" });
  const res = await app(
    form("/login", { password: PASSWORD }, { "sec-fetch-site": "cross-site" }),
  );
  assertEquals(res.status, 403);
  // The JSON routes also refuse anything that isn't JSON (a plain cross-site form can't send it).
  const notJson = await app(form("/login/passkey", { credentialId: "x" }));
  assertEquals(notJson.status, 400);
});

Deno.test("without a secure base URL, passkeys are off and no page loads a script", async () => {
  for (const baseUrl of [undefined, "http://nucklehead"]) {
    const { app } = await setup({ baseUrl });
    const login = await (await app(get("/login"))).text();
    assert(!login.includes("<script"), "sign-in page should have no script");
    assert(!login.includes("data-passkey-signin"));
    assertEquals((await app(jsonPost("/login/passkey/options", {}))).status, 404);

    const c = await signIn(app);
    const account = await (await app(get("/account", { cookie: c }))).text();
    assert(!account.includes("<script"));
    assertStringIncludes(account, "Passkeys are off");
    assertStringIncludes(
      account,
      baseUrl ? "only allow passkeys over HTTPS" : "BALLOTFIX_BASE_URL",
    );
  }
});

Deno.test("with HTTPS, only the sign-in and account pages get the script and its CSP", async () => {
  const { app } = await setup({ baseUrl: "https://ballot.example.ts.net", basePath: "/ballotfix" });
  const login = await app(get("/ballotfix/login"));
  assertStringIncludes(login.headers.get("content-security-policy") ?? "", "script-src 'self'");
  const html = await login.text();
  assertStringIncludes(html, `<script src="/ballotfix/static/webauthn.js" defer></script>`);
  assertStringIncludes(html, `data-options="/ballotfix/login/passkey/options"`);

  const c = await signIn(app);
  const home = await app(get("/ballotfix/", { cookie: c }));
  assert(!(home.headers.get("content-security-policy") ?? "").includes("script-src"));
  assert(!(await home.text()).includes("<script"));

  const options = await app(jsonPost("/ballotfix/login/passkey/options", {}));
  assertEquals(options.status, 200);
  const body = await options.json();
  assertEquals(body.rpId, "ballot.example.ts.net");
  assertEquals(body.userVerification, "required");
  assert(!("allowCredentials" in body), "never list registered credentials to a stranger");

  const reg = await app(jsonPost("/ballotfix/account/passkeys/options", {}, { cookie: c }));
  const regBody = await reg.json();
  assertEquals(regBody.rp.id, "ballot.example.ts.net");
  assertEquals(regBody.authenticatorSelection.residentKey, "required");
});

Deno.test("the account page warns when opened at a different host than the passkeys belong to", async () => {
  const { app } = await setup({ baseUrl: "https://ballot.example.ts.net" });
  const c = await signIn(app);
  const account = await (await app(get("/account", { cookie: c }))).text();
  assertStringIncludes(account, "but this\npage was opened at <code>app.test</code>");
});

Deno.test("a bad passkey sign-in is refused and counts as a failure", async () => {
  const { app } = await setup({ baseUrl: "https://ballot.example.ts.net" });
  for (let i = 0; i < 4; i++) {
    const res = await app(jsonPost("/login/passkey", { credentialId: "nope" }));
    assertEquals(res.status, 401);
    assert(!res.headers.get("set-cookie"));
  }
  assertEquals((await app(form("/login", { password: PASSWORD }))).status, 429);
});

Deno.test("renaming and removing passkeys only touches ones that exist", async () => {
  const { app, authStore } = await setup({ baseUrl: "https://ballot.example.ts.net" });
  const c = await signIn(app);
  const id = crypto.randomUUID();
  await authStore.update((s) => {
    s.credentials.push({
      id,
      credentialId: "cred",
      publicKey: "key",
      signCount: 0,
      transports: [],
      aaguid: null,
      backedUp: true,
      label: "Phone",
      createdAt: "2026-10-01T00:00:00Z",
      lastUsedAt: null,
    });
  });
  const renamed = await app(
    form(`/account/passkeys/${id}/rename`, { label: "<b>Laptop</b>" }, { cookie: c }),
  );
  assertEquals(renamed.headers.get("location"), "/account?notice=renamed");
  const page = await (await app(get(renamed.headers.get("location")!, { cookie: c }))).text();
  assertStringIncludes(page, "&lt;b&gt;Laptop&lt;/b&gt;");
  assertStringIncludes(page, "Renamed.");

  const missing = await app(
    form(`/account/passkeys/${crypto.randomUUID()}/delete`, {}, { cookie: c }),
  );
  assertEquals(missing.headers.get("location"), "/account?error=missing");
  const removed = await app(form(`/account/passkeys/${id}/delete`, {}, { cookie: c }));
  assertEquals(removed.headers.get("location"), "/account?notice=removed");
  assertEquals(authStore.state.credentials.length, 0);
});

Deno.test("only HTTPS or localhost origins can use passkeys", () => {
  assertEquals(expectedOriginFrom(undefined), null);
  assertEquals(expectedOriginFrom("http://nucklehead"), null);
  assertEquals(expectedOriginFrom("http://100.64.0.1:8421"), null);
  assertEquals(expectedOriginFrom("https://n.example.ts.net"), {
    rpId: "n.example.ts.net",
    origin: "https://n.example.ts.net",
  });
  assertEquals(expectedOriginFrom("http://localhost:8788"), {
    rpId: "localhost",
    origin: "http://localhost:8788",
  });
});
