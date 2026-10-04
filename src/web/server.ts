/**
 * The Ballot Fix web app. Plain HTML forms and server-rendered pages: no
 * client JavaScript, so the strict CSP from render.ts applies everywhere.
 *
 * Routes:
 *   GET  /                      home: new-race form and saved races
 *   POST /races                 start a race, then redirect to it
 *   GET  /races/:id             race page (refreshes itself while running)
 *   POST /races/:id/rerun       research the same race again
 *   GET  /races/:id/download    standalone HTML file of a finished race
 *   GET  /races/:id.json        raw run record
 *   GET  /healthz
 */

import { renderRace, slug } from "../render.ts";
import type { BallotCandidate, RaceQuery } from "../types.ts";
import { type JobRunner, QueueFullError } from "./jobs.ts";
import { DEFAULT_FORM, type FormValues, homePage, messagePage, runPage } from "./pages.ts";
import { isRunId, type RunStore } from "./store.ts";

export interface AppOptions {
  store: RunStore;
  jobs: JobRunner;
  /** False when no API key is configured: pages still work, research is disabled. */
  canResearch: boolean;
  /** When set, every request needs HTTP Basic auth with this password (any username). */
  password?: string;
}

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

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, password: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  return colon >= 0 && timingSafeEqual(decoded.slice(colon + 1), password);
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
  if (origin === null) return true; // Non-browser clients; the password, if set, still applies.
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
  const start = async (
    query: RaceQuery,
    candidates: BallotCandidate[] | null,
    values: FormValues,
  ) => {
    try {
      const run = await o.jobs.submit(query, candidates);
      return redirect(`/races/${run.id}`);
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err;
      return html(
        homePage({ runs: await o.store.list(), canResearch: true, values, error: err.message }),
        429,
      );
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok", { headers: SECURITY_HEADERS });

    if (o.password && !authorized(req, o.password)) {
      return new Response("Password required.", {
        status: 401,
        headers: {
          "www-authenticate": 'Basic realm="Ballot Fix", charset="UTF-8"',
          ...SECURITY_HEADERS,
        },
      });
    }

    if (req.method === "POST" && !sameOrigin(req)) {
      return html(messagePage("Not allowed", "That request didn't come from this app."), 403);
    }

    if (path === "/" && req.method === "GET") {
      return html(homePage({ runs: await o.store.list(), canResearch: o.canResearch }));
    }

    if (path === "/races" && req.method === "POST") {
      if (!o.canResearch) {
        return html(
          messagePage("Research is off", "ANTHROPIC_API_KEY isn't set on the server."),
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
          homePage({ runs: await o.store.list(), canResearch: true, values, error: parsed.error }),
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
        return html(messagePage("Not found", "There's no saved race at that address."), 404);
      }

      if (!suffix && req.method === "GET") return html(runPage(run, o.canResearch));
      if (suffix === ".json" && req.method === "GET") {
        return new Response(JSON.stringify(run, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
        });
      }
      if (suffix === "/download" && req.method === "GET") {
        if (!run.race || run.status !== "done") {
          return html(messagePage("Not ready", "This race hasn't finished researching yet."), 409);
        }
        const name = slug(`${run.query.city}-${run.query.office}-${run.query.electionDate}`);
        return html(renderRace(run.race), 200, {
          "content-disposition": `attachment; filename="${name}.html"`,
        });
      }
      if (suffix === "/rerun" && req.method === "POST") {
        if (!o.canResearch) {
          return html(
            messagePage("Research is off", "ANTHROPIC_API_KEY isn't set on the server."),
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
      return html(messagePage("Not allowed", "That action isn't available here."), 405);
    }

    return html(messagePage("Not found", "There's nothing at that address."), 404);
  };
}
