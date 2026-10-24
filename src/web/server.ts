/**
 * The Ballot Fix web app. Plain HTML forms and server-rendered pages. The only
 * client JavaScript is static/webauthn.js, loaded by the sign-in and account
 * pages for passkeys; every other page keeps render.ts's no-script CSP.
 *
 * Routes:
 *   GET  /                      home: new-race form and saved races
 *   POST /races                 start a race, then redirect to it
 *   GET  /races/:id             race page (refreshes itself while running)
 *   POST /races/:id/rerun       research the same race again
 *   GET  /races/:id/download    standalone HTML file of a finished race
 *   GET  /races/:id.json        raw run record
 *   GET  /healthz
 *
 * With sign-in on (BALLOTFIX_PASSWORD set), everything except /healthz, the
 * sign-in routes and the script needs a session:
 *   GET  /login                 sign-in page: passkey button and password form
 *   POST /login                 password sign-in
 *   POST /login/passkey/options, /login/passkey      passkey sign-in (JSON)
 *   POST /logout
 *   GET  /account               passkeys and sessions
 *   POST /account/passkeys/options, /account/passkeys  register a passkey (JSON)
 *   POST /account/passkeys/:id/rename, /account/passkeys/:id/delete
 *   POST /account/sign-out-everywhere
 *   GET  /static/webauthn.js
 */

import { ABSOLUTE_LIFETIME_MS, type Auth, SESSION_COOKIE, WebAuthnError } from "../auth/auth.ts";
import type { AuthenticationResponse, RegistrationResponse } from "../auth/webauthn/ceremony.ts";
import { renderRace, SCRIPT_PAGE_CSP, slug } from "../render.ts";
import type { BallotCandidate, RaceQuery } from "../types.ts";
import { type JobRunner, QueueFullError } from "./jobs.ts";
import {
  accountPage,
  DEFAULT_FORM,
  type FormValues,
  homePage,
  loginPage,
  messagePage,
  type PasskeySetup,
  runPage,
} from "./pages.ts";
import { isRunId, type RunStore } from "./store.ts";

const WEBAUTHN_JS = await Deno.readTextFile(new URL("./webauthn.js", import.meta.url));

export interface AppOptions {
  store: RunStore;
  jobs: JobRunner;
  /** False when no API key is configured: pages still work, research is disabled. */
  canResearch: boolean;
  /**
   * When set, sign-in is on: every route but /healthz and the sign-in routes
   * needs a session, from the password or a passkey.
   */
  auth?: Auth;
  /** BALLOTFIX_BASE_URL as configured, for explaining why passkeys are off. */
  baseUrl?: string;
  /**
   * Mount prefix (e.g. "/ballotfix") when served behind a Caddy `handle` block that
   * preserves the path, like tower-expert — see its main.ts. Requests are accepted
   * both with and without this prefix, so direct/local access keeps working. Every
   * generated link, form action, and redirect carries it; empty (default) is root.
   */
  basePath?: string;
}

/** Fixed messages for the account page, so a link can't put arbitrary text on it. */
const ACCOUNT_NOTICES: Record<string, string> = {
  added: "Passkey added. You can sign in with it from now on.",
  renamed: "Renamed.",
  removed: "That passkey has been removed and can no longer sign in.",
};
const ACCOUNT_ERRORS: Record<string, string> = {
  missing: "That passkey isn't registered.",
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  "x-content-type-options": "nosniff",
  // same-origin, not no-referrer: under no-referrer, browsers send "Origin: null" on the
  // app's own form posts. Outbound links already carry rel="noreferrer".
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, ...SECURITY_HEADERS } });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

function cookie(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * Only an app path is a valid place to land after signing in: one leading
 * slash, so never `//evil.example` or `/\\evil.example`, which browsers treat
 * as another host.
 */
function safeNext(next: string, base: string): string {
  // deno-lint-ignore no-control-regex
  return /^\/(?![/\\])[^\\\u0000-\u001f]*$/.test(next) && next.length <= 500 ? next : `${base}/`;
}

/**
 * Starting research spends money, so a POST must come from this app's own
 * pages, not a form on some other site. Browsers send Sec-Fetch-Site, which
 * is the reliable signal; Origin is the fallback for ones that don't.
 * (An "Origin: null" can't be attributed to anyone and is refused.)
 */
function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (origin === null) return true; // Non-browser clients; sign-in, if on, still applies.
  if (origin === "null") return false;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

type Parsed = { ok: true; query: RaceQuery; candidates: BallotCandidate[] | null } | {
  ok: false;
  error: string;
};

export function parseRaceForm(v: FormValues): Parsed {
  if (!v.city || v.city.length > 80) {
    return { ok: false, error: "Enter a city (up to 80 characters)." };
  }
  if (!/^[A-Za-z]{2}$/.test(v.state)) {
    return { ok: false, error: "State should be a two-letter code, like CA." };
  }
  if (!v.office || v.office.length > 80) {
    return { ok: false, error: "Enter an office (up to 80 characters)." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.election) || isNaN(Date.parse(v.election))) {
    return { ok: false, error: "Election date should be a date, like 2026-11-03." };
  }
  const names = v.candidates.split(/[\n;]/).map((n) => n.trim()).filter(Boolean);
  if (names.length > 20) return { ok: false, error: "Up to 20 candidates per race." };
  if (names.some((n) => n.length > 100)) {
    return { ok: false, error: "Candidate names can be up to 100 characters." };
  }
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    return { ok: false, error: "A candidate is listed twice." };
  }
  const inc = v.incumbent.toLowerCase();
  if (inc && names.length && !names.some((n) => n.toLowerCase() === inc)) {
    return { ok: false, error: "The current office holder must match one of the candidate names." };
  }
  return {
    ok: true,
    query: {
      city: v.city,
      state: v.state.toUpperCase(),
      office: v.office,
      electionDate: v.election,
    },
    candidates: names.length
      ? names.map((name) => ({
        name,
        ballot_designation: null,
        incumbent: name.toLowerCase() === inc,
      }))
      : null,
  };
}

export function createApp(o: AppOptions): (req: Request) => Promise<Response> {
  const BASE = (o.basePath ?? "").replace(/\/+$/, "");
  const auth = o.auth;
  const ACCOUNT = Boolean(auth);
  // Secure cookies only work over HTTPS, which is also when passkeys do.
  const secure = o.baseUrl?.startsWith("https:") ?? false;

  const sessionCookie = (token: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${
      secure ? "; Secure" : ""
    }`;
  const signedInCookie = async (a: Auth, req: Request) =>
    sessionCookie(
      await a.issueSession(req.headers.get("user-agent")),
      Math.floor(ABSOLUTE_LIFETIME_MS / 1000),
    );
  const tooMany = (seconds: number) => `Too many attempts. Try again in ${seconds} seconds.`;

  const passkeySetup = (a: Auth, url: URL): PasskeySetup => {
    if (!a.expected) {
      return o.baseUrl ? { state: "insecure", baseUrl: o.baseUrl } : { state: "no-base-url" };
    }
    // Compare hosts, not origins: behind Caddy this process sees plain http.
    const host = new URL(a.expected.origin).host;
    return {
      state: "ready",
      origin: a.expected.origin,
      elsewhere: url.host === host ? null : url.host,
    };
  };

  const readJson = async <T>(req: Request): Promise<T | null> => {
    // Requiring JSON also means a cross-site form can't reach these at all.
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return null;
    try {
      const body = await req.json();
      return body && typeof body === "object" ? body as T : null;
    } catch {
      return null;
    }
  };

  /**
   * Sign-in routes and the session gate. Returns a response when the request
   * is one of these routes or is refused; null lets it through to the app.
   * Everything not explicitly public here needs a session, so a route added
   * later is private by default.
   */
  const authRoute = async (
    a: Auth,
    req: Request,
    path: string,
    url: URL,
  ): Promise<Response | null> => {
    const m = req.method;
    const next = safeNext(url.searchParams.get("next") ?? "", BASE);

    if (path === "/static/webauthn.js" && m === "GET") {
      return new Response(WEBAUTHN_JS, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
          ...SECURITY_HEADERS,
        },
      });
    }

    const loginHtml = (status: number, extra: { error?: string; notice?: string; next?: string }) =>
      html(
        loginPage({
          base: BASE,
          next: extra.next ?? next,
          passkeys: a.expected !== null,
          ...extra,
        }),
        status,
        { "content-security-policy": SCRIPT_PAGE_CSP, "cache-control": "no-store" },
      );

    if (path === "/login" && m === "GET") {
      if (await a.validSession(cookie(req, SESSION_COOKIE))) return redirect(next);
      const notice = url.searchParams.has("signedout") ? "Signed out." : undefined;
      return loginHtml(200, { notice });
    }

    if (path === "/login" && m === "POST") {
      const form = await req.formData();
      const formNext = safeNext(field(form, "next"), BASE);
      const wait = a.retryAfterSeconds();
      if (wait > 0) return loginHtml(429, { error: tooMany(wait), next: formNext });
      if (!a.checkPassword(String(form.get("password") ?? ""))) {
        return loginHtml(401, { error: "That password isn't right.", next: formNext });
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: formNext,
          "set-cookie": await signedInCookie(a, req),
          ...SECURITY_HEADERS,
        },
      });
    }

    if (path === "/login/passkey/options" && m === "POST") {
      const wait = a.retryAfterSeconds();
      if (wait > 0) return json({ error: tooMany(wait) }, 429, { "retry-after": String(wait) });
      if (!a.expected) return json({ error: "Passkeys aren't set up on this server." }, 404);
      return json(a.beginAuthentication());
    }

    if (path === "/login/passkey" && m === "POST") {
      const wait = a.retryAfterSeconds();
      if (wait > 0) return json({ error: tooMany(wait) }, 429, { "retry-after": String(wait) });
      const body = await readJson<AuthenticationResponse & { next?: unknown }>(req);
      if (!body) return json({ error: "Malformed request." }, 400);
      try {
        await a.finishAuthentication(body);
      } catch (err) {
        if (err instanceof WebAuthnError) return json({ error: err.message }, 401);
        throw err;
      }
      const to = safeNext(typeof body.next === "string" ? body.next : "", BASE);
      return json({ redirect: to }, 200, { "set-cookie": await signedInCookie(a, req) });
    }

    // Everything below needs a session.
    const token = cookie(req, SESSION_COOKIE);
    if (!await a.validSession(token)) {
      const clear: Record<string, string> = token ? { "set-cookie": sessionCookie("", 0) } : {};
      if (m === "GET" || m === "HEAD") {
        const back = encodeURIComponent(url.pathname + url.search);
        return new Response(null, {
          status: 303,
          headers: { location: `${BASE}/login?next=${back}`, ...clear, ...SECURITY_HEADERS },
        });
      }
      return html(
        messagePage("Signed out", "Sign in again, then retry that.", BASE, ACCOUNT),
        401,
        clear,
      );
    }

    if (path === "/logout" && m === "POST") {
      await a.endSession(token);
      return new Response(null, {
        status: 303,
        headers: {
          location: `${BASE}/login?signedout`,
          "set-cookie": sessionCookie("", 0),
          ...SECURITY_HEADERS,
        },
      });
    }

    if (path === "/account/sign-out-everywhere" && m === "POST") {
      await a.endAllSessions();
      return new Response(null, {
        status: 303,
        headers: {
          location: `${BASE}/login?signedout`,
          "set-cookie": sessionCookie("", 0),
          ...SECURITY_HEADERS,
        },
      });
    }

    if (path === "/account" && m === "GET") {
      const notice = ACCOUNT_NOTICES[url.searchParams.get("notice") ?? ""];
      const error = ACCOUNT_ERRORS[url.searchParams.get("error") ?? ""];
      return html(
        accountPage({
          base: BASE,
          setup: passkeySetup(a, url),
          credentials: a.credentials(),
          sessions: a.sessionCount(),
          notice,
          error,
        }),
        200,
        { "content-security-policy": SCRIPT_PAGE_CSP, "cache-control": "no-store" },
      );
    }

    if (path === "/account/passkeys/options" && m === "POST") {
      if (!a.expected) return json({ error: "Passkeys aren't set up on this server." }, 404);
      return json(a.beginRegistration());
    }

    if (path === "/account/passkeys" && m === "POST") {
      const body = await readJson<RegistrationResponse & { label?: unknown }>(req);
      if (!body) return json({ error: "Malformed request." }, 400);
      try {
        await a.finishRegistration(typeof body.label === "string" ? body.label : "", body);
      } catch (err) {
        if (err instanceof WebAuthnError) return json({ error: err.message }, 400);
        throw err;
      }
      return json({ redirect: `${BASE}/account?notice=added` });
    }

    const pk = path.match(/^\/account\/passkeys\/([0-9a-f-]{36})\/(rename|delete)$/);
    if (pk && m === "POST") {
      const [, id, action] = pk;
      const found = action === "rename"
        ? await a.rename(id, field(await req.formData(), "label"))
        : await a.remove(id);
      const q = !found
        ? "error=missing"
        : action === "rename"
        ? "notice=renamed"
        : "notice=removed";
      return redirect(`${BASE}/account?${q}`);
    }

    return null;
  };
  const start = async (
    query: RaceQuery,
    candidates: BallotCandidate[] | null,
    values: FormValues,
  ) => {
    try {
      const run = await o.jobs.submit(query, candidates);
      return redirect(`${BASE}/races/${run.id}`);
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err;
      return html(
        homePage({
          runs: await o.store.list(),
          canResearch: true,
          values,
          error: err.message,
          base: BASE,
          account: ACCOUNT,
        }),
        429,
      );
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Accept the path with or without BASE, so direct/local access (no proxy
    // prefix) keeps working alongside the Caddy-forwarded prefixed one.
    let path = url.pathname;
    if (BASE) {
      if (path === BASE) path = "/";
      else if (path.startsWith(`${BASE}/`)) path = path.slice(BASE.length);
    }

    if (path === "/healthz") return new Response("ok", { headers: SECURITY_HEADERS });

    if (req.method === "POST" && !sameOrigin(req)) {
      return html(
        messagePage("Not allowed", "That request didn't come from this app.", BASE, ACCOUNT),
        403,
      );
    }

    if (auth) {
      const handled = await authRoute(auth, req, path, url);
      if (handled) return handled;
    }

    if (path === "/" && req.method === "GET") {
      return html(
        homePage({
          runs: await o.store.list(),
          canResearch: o.canResearch,
          base: BASE,
          account: ACCOUNT,
        }),
      );
    }

    if (path === "/races" && req.method === "POST") {
      if (!o.canResearch) {
        return html(
          messagePage(
            "Research is off",
            "ANTHROPIC_API_KEY isn't set on the server.",
            BASE,
            ACCOUNT,
          ),
          503,
        );
      }
      const form = await req.formData();
      const values: FormValues = {
        city: field(form, "city"),
        state: field(form, "state") || DEFAULT_FORM.state,
        office: field(form, "office"),
        election: field(form, "election"),
        candidates: field(form, "candidates"),
        incumbent: field(form, "incumbent"),
      };
      const parsed = parseRaceForm(values);
      if (!parsed.ok) {
        return html(
          homePage({
            runs: await o.store.list(),
            canResearch: true,
            values,
            error: parsed.error,
            base: BASE,
            account: ACCOUNT,
          }),
          400,
        );
      }
      return await start(parsed.query, parsed.candidates, values);
    }

    const m = path.match(/^\/races\/([^/]+?)(\.json|\/rerun|\/download)?$/);
    if (m) {
      const [, id, suffix] = m;
      const run = isRunId(id) ? await o.store.get(id) : null;
      if (!run) {
        return html(
          messagePage("Not found", "There's no saved race at that address.", BASE, ACCOUNT),
          404,
        );
      }

      if (!suffix && req.method === "GET") return html(runPage(run, o.canResearch, BASE, ACCOUNT));
      if (suffix === ".json" && req.method === "GET") {
        return new Response(JSON.stringify(run, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
        });
      }
      if (suffix === "/download" && req.method === "GET") {
        if (!run.race || run.status !== "done") {
          return html(
            messagePage("Not ready", "This race hasn't finished researching yet.", BASE, ACCOUNT),
            409,
          );
        }
        const name = slug(`${run.query.city}-${run.query.office}-${run.query.electionDate}`);
        return html(renderRace(run.race), 200, {
          "content-disposition": `attachment; filename="${name}.html"`,
        });
      }
      if (suffix === "/rerun" && req.method === "POST") {
        if (!o.canResearch) {
          return html(
            messagePage(
              "Research is off",
              "ANTHROPIC_API_KEY isn't set on the server.",
              BASE,
              ACCOUNT,
            ),
            503,
          );
        }
        const values: FormValues = {
          ...DEFAULT_FORM,
          city: run.query.city,
          state: run.query.state,
          office: run.query.office,
          election: run.query.electionDate,
        };
        return await start(run.query, run.candidates, values);
      }
      return html(
        messagePage("Not allowed", "That action isn't available here.", BASE, ACCOUNT),
        405,
      );
    }

    return html(messagePage("Not found", "There's nothing at that address.", BASE, ACCOUNT), 404);
  };
}
