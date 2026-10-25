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
 *   POST /ballots               upload photos/PDF of a ballot, then redirect to it
 *   GET  /ballots/:id           reading progress, then the contests found, for review
 *   POST /ballots/:id/research  start races for the contests the user picked
 *   GET  /healthz
 */

import { renderRace, slug } from "../render.ts";
import type {
  BallotCandidate,
  BallotMediaType,
  BallotPage,
  CandidateSource,
  RaceQuery,
} from "../types.ts";
import { type BallotJobs, type JobRunner, QueueFullError } from "./jobs.ts";
import {
  ballotPage,
  DEFAULT_FORM,
  type FormValues,
  type HomeOptions,
  homePage,
  MAX_BALLOT_FILE_BYTES,
  MAX_BALLOT_FILES,
  MAX_BALLOT_TOTAL_BYTES,
  messagePage,
  runPage,
} from "./pages.ts";
import { type BallotRecord, isRunId, type RunStore } from "./store.ts";

export interface AppOptions {
  store: RunStore;
  jobs: JobRunner;
  /** Reads uploaded ballots. Without it, the upload routes are 404s. */
  ballots?: BallotJobs;
  /** False when no API key is configured: pages still work, research is disabled. */
  canResearch: boolean;
  /** When set, every request needs HTTP Basic auth with this password (any username). */
  password?: string;
  /**
   * Mount prefix (e.g. "/ballotfix") when served behind a Caddy `handle` block that
   * preserves the path, like tower-expert — see its main.ts. Requests are accepted
   * both with and without this prefix, so direct/local access keeps working. Every
   * generated link, form action, and redirect carries it; empty (default) is root.
   */
  basePath?: string;
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
  // Several seats can mean several incumbents running: "A; B" or one per line.
  const incs = new Set(
    v.incumbent.split(/[\n;]/).map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  const lower = new Set(names.map((n) => n.toLowerCase()));
  if (incs.size && names.length && [...incs].some((n) => !lower.has(n))) {
    return {
      ok: false,
      error: "Each current office holder must match one of the candidate names.",
    };
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
        incumbent: incs.has(name.toLowerCase()),
      }))
      : null,
  };
}

/**
 * The file's real type from its first bytes; the browser's claimed type isn't
 * trusted. "heic" is recognized only to explain how to send a JPEG instead.
 */
export function sniffBallotType(b: Uint8Array): BallotMediaType | "heic" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|heif|mif1|msf1)$/.test(ascii(8, 12))) {
    return "heic";
  }
  return null;
}

/** Past this, an oversized upload is cut off rather than read to the end just to reply. */
const MAX_DRAIN_BYTES = 128 * 1024 * 1024;

/**
 * Reads and discards the rest of a body, so the browser finishes sending and
 * shows the error page instead of a connection reset.
 */
async function drain(body: ReadableStream<Uint8Array>, alreadyRead: number): Promise<void> {
  let size = alreadyRead;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > MAX_DRAIN_BYTES) break;
    }
  } catch {
    // The client went away; nothing to answer.
  }
}

/** The request body, refusing to buffer more than `max` bytes. */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array();
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) {
    await drain(req.body, 0);
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body) {
    size += chunk.length;
    if (size > max) {
      await drain(req.body, size);
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const MB = 1024 * 1024;
const BALLOTS_BUSY = "Other ballots are being read right now. Try again in a minute.";

export async function parseBallotUpload(
  form: FormData,
): Promise<{ ok: true; pages: BallotPage[] } | { ok: false; error: string }> {
  const files = form.getAll("pages").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) {
    return { ok: false, error: "Choose at least one photo or PDF of your ballot." };
  }
  if (files.length > MAX_BALLOT_FILES) {
    return { ok: false, error: `Up to ${MAX_BALLOT_FILES} files per ballot.` };
  }
  const pages: BallotPage[] = [];
  let total = 0;
  for (const f of files) {
    const name = f.name ? `"${f.name.slice(0, 60)}"` : "A file";
    if (f.size > MAX_BALLOT_FILE_BYTES) {
      return {
        ok: false,
        error: `${name} is ${(f.size / MB).toFixed(1)} MB; each file can be up to ${
          MAX_BALLOT_FILE_BYTES / MB
        } MB. Try a lower-resolution photo, or split the PDF.`,
      };
    }
    total += f.size;
    const data = new Uint8Array(await f.arrayBuffer());
    const type = sniffBallotType(data);
    if (type === "heic") {
      return {
        ok: false,
        error:
          `${name} is a HEIC photo, which can't be read. On iPhone, set Settings > Camera > Formats to Most Compatible, or upload it from a browser that converts photos to JPEG.`,
      };
    }
    if (!type) {
      return { ok: false, error: `${name} isn't a JPEG, PNG, WebP, or PDF file.` };
    }
    pages.push({ media_type: type, data });
  }
  if (total > MAX_BALLOT_TOTAL_BYTES) {
    return {
      ok: false,
      error: `These files add up to ${(total / MB).toFixed(1)} MB; the limit is ${
        MAX_BALLOT_TOTAL_BYTES / MB
      } MB per ballot.`,
    };
  }
  return { ok: true, pages };
}

/** Listing source for races started from an uploaded ballot, names and order as read. */
export const UPLOADED_BALLOT_SOURCE: CandidateSource = {
  source_name: "Your uploaded ballot",
  order_basis: "official_ballot_order",
  notes:
    "Names and order were read by AI from the ballot images you uploaded and checked by you before research. The images weren't kept, so this list can't be linked.",
};

/**
 * Listing source once the user changed the list read from the ballot. Any
 * change (a respelling, an added, removed, or moved name) means the order is
 * no longer confirmed as the ballot's, so it isn't labeled as ballot order.
 */
export const EDITED_BALLOT_SOURCE: CandidateSource = {
  source_name: "Your uploaded ballot, edited by you",
  order_basis: "unofficial",
  notes:
    "Read by AI from the ballot images you uploaded, then changed by you before research, so the order is as you entered it and not confirmed as the ballot's. The images weren't kept, so this list can't be linked.",
};

type Picked = {
  index: number;
  query: RaceQuery;
  candidates: BallotCandidate[];
  source: CandidateSource;
};

/** Validates the ballot review form: which contests to research, and the user's corrections. */
export function parseBallotResearch(
  b: BallotRecord,
  form: FormData,
): { ok: true; picks: Picked[] } | { ok: false; error: string } {
  const r = b.reading;
  if (!r) return { ok: false, error: "This ballot hasn't been read." };
  const raw = form.getAll("pick").map(String);
  if (!raw.length) return { ok: false, error: "Choose at least one contest to research." };
  // Only plain digits: "01", "1e0", or "" must not alias another contest.
  if (raw.some((v) => !/^(0|[1-9]\d{0,3})$/.test(v))) {
    return { ok: false, error: "That contest isn't available to research." };
  }
  const indexes = [...new Set(raw.map(Number))];
  const picks: Picked[] = [];
  for (const i of indexes) {
    const contest = r.contests[i];
    if (!contest || b.started[String(i)]) {
      return { ok: false, error: "That contest isn't available to research." };
    }
    const values: FormValues = {
      city: field(form, `city_${i}`),
      state: field(form, "state"),
      office: field(form, `office_${i}`),
      election: field(form, "election"),
      candidates: field(form, `candidates_${i}`),
      incumbent: field(form, `incumbent_${i}`),
    };
    const parsed = parseRaceForm(values);
    const label = values.office || contest.office;
    if (!parsed.ok) return { ok: false, error: `${label}: ${parsed.error}` };
    if (!parsed.candidates) {
      return { ok: false, error: `${label}: list at least one candidate.` };
    }
    // Keep the designations read from the ballot for names the user didn't change.
    const read = new Map(contest.candidates.map((c) => [c.name.toLowerCase(), c]));
    const edited = parsed.candidates.length !== contest.candidates.length ||
      parsed.candidates.some((c, k) =>
        c.name.toLowerCase() !== contest.candidates[k].name.toLowerCase()
      );
    picks.push({
      index: i,
      query: parsed.query,
      candidates: parsed.candidates.map((c) => ({
        ...c,
        ballot_designation: read.get(c.name.toLowerCase())?.ballot_designation ?? null,
      })),
      source: edited ? EDITED_BALLOT_SOURCE : UPLOADED_BALLOT_SOURCE,
    });
  }
  return { ok: true, picks };
}

export function createApp(o: AppOptions): (req: Request) => Promise<Response> {
  const BASE = (o.basePath ?? "").replace(/\/+$/, "");
  /** Ballot ids whose contests are being started right now. */
  const starting = new Set<string>();
  const home = async (extra: Partial<HomeOptions> = {}) =>
    homePage({
      runs: await o.store.list(),
      ballots: o.ballots ? await o.ballots.store.list() : [],
      canUpload: Boolean(o.ballots),
      canResearch: o.canResearch,
      base: BASE,
      ...extra,
    });
  const start = async (
    query: RaceQuery,
    candidates: BallotCandidate[] | null,
    values: FormValues,
    source: CandidateSource | null = null,
  ) => {
    try {
      const run = await o.jobs.submit(query, candidates, source);
      return redirect(`${BASE}/races/${run.id}`);
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err;
      return html(await home({ values, error: err.message }), 429);
    }
  };
  const researchOff = () =>
    html(messagePage("Research is off", "ANTHROPIC_API_KEY isn't set on the server.", BASE), 503);

  const ballotRoutes = async (req: Request, path: string): Promise<Response | null> => {
    const ballots = o.ballots;
    if (!ballots) return null;

    if (path === "/ballots" && req.method === "POST") {
      if (!o.canResearch) return researchOff();
      // Refuse before buffering an upload that couldn't be read anyway. submit() checks again.
      if (ballots.full) {
        if (req.body) await drain(req.body, 0);
        return html(await home({ ballotError: BALLOTS_BUSY }), 429);
      }
      // Headroom over the file limit for multipart boundaries and headers.
      const body = await readCapped(req, MAX_BALLOT_TOTAL_BYTES + MB);
      if (!body) {
        return html(
          await home({
            ballotError: `That upload is over ${
              MAX_BALLOT_TOTAL_BYTES / MB
            } MB. Use fewer or smaller files.`,
          }),
          413,
        );
      }
      let form: FormData;
      try {
        form = await new Response(body, {
          headers: { "content-type": req.headers.get("content-type") ?? "" },
        }).formData();
      } catch {
        return html(await home({ ballotError: "That upload couldn't be read. Try again." }), 400);
      }
      const parsed = await parseBallotUpload(form);
      if (!parsed.ok) return html(await home({ ballotError: parsed.error }), 400);
      try {
        const record = await ballots.submit(parsed.pages);
        return redirect(`${BASE}/ballots/${record.id}`);
      } catch (err) {
        if (!(err instanceof QueueFullError)) throw err;
        return html(await home({ ballotError: BALLOTS_BUSY }), 429);
      }
    }

    const m = path.match(/^\/ballots\/([^/]+?)(\/research)?$/);
    if (!m) return null;
    const [, id, suffix] = m;
    const b = isRunId(id) ? await ballots.store.get(id) : null;
    if (!b) {
      return html(messagePage("Not found", "There's no saved ballot at that address.", BASE), 404);
    }
    const view = () => ({ canResearch: o.canResearch, available: o.jobs.available, base: BASE });

    if (!suffix && req.method === "GET") return html(ballotPage(b, view()));
    if (suffix === "/research" && req.method === "POST") {
      if (!o.canResearch) return researchOff();
      const form = await req.formData();
      // One start at a time per ballot, so a double-click or a second tab can't
      // start (and pay for) the same contest twice. Checked and taken with no
      // await in between; the record is re-read under the lock.
      if (starting.has(b.id)) {
        return html(
          ballotPage(b, {
            ...view(),
            error: "These contests are already being started. Reload this page in a moment.",
          }),
          409,
        );
      }
      starting.add(b.id);
      try {
        const fresh = (await ballots.store.get(b.id)) ?? b;
        const parsed = parseBallotResearch(fresh, form);
        let error = parsed.ok ? null : parsed.error;
        const available = o.jobs.available;
        if (parsed.ok && parsed.picks.length > available) {
          error = available
            ? `Only ${available} more race${
              available === 1 ? "" : "s"
            } can be started right now. Choose fewer, then add the rest when those finish.`
            : "Other races are researching right now. Try again when one finishes.";
        }
        if (!parsed.ok || error) {
          return html(ballotPage(fresh, { ...view(), form, error: error ?? undefined }), 400);
        }
        const started = { ...fresh.started };
        let last = "";
        let updated = fresh;
        try {
          for (const p of parsed.picks) {
            const run = await o.jobs.submit(p.query, p.candidates, p.source);
            started[String(p.index)] = run.id;
            last = run.id;
          }
        } catch (err) {
          if (!(err instanceof QueueFullError)) throw err;
          error = err.message;
        } finally {
          // Record whatever did start, even if a later submit failed, so a retry can't repeat it.
          updated = { ...fresh, started, updated_at: new Date().toISOString() };
          await ballots.store.save(updated);
        }
        if (error) return html(ballotPage(updated, { ...view(), form, error }), 429);
        return redirect(
          parsed.picks.length === 1 ? `${BASE}/races/${last}` : `${BASE}/ballots/${b.id}`,
        );
      } finally {
        starting.delete(b.id);
      }
    }
    return html(messagePage("Not allowed", "That action isn't available here.", BASE), 405);
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
      return html(
        messagePage("Not allowed", "That request didn't come from this app.", BASE),
        403,
      );
    }

    if (path === "/" && req.method === "GET") return html(await home());

    const ballotResponse = await ballotRoutes(req, path);
    if (ballotResponse) return ballotResponse;

    if (path === "/races" && req.method === "POST") {
      if (!o.canResearch) return researchOff();
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
      if (!parsed.ok) return html(await home({ values, error: parsed.error }), 400);
      return await start(parsed.query, parsed.candidates, values);
    }

    const m = path.match(/^\/races\/([^/]+?)(\.json|\/rerun|\/download)?$/);
    if (m) {
      const [, id, suffix] = m;
      const run = isRunId(id) ? await o.store.get(id) : null;
      if (!run) {
        return html(messagePage("Not found", "There's no saved race at that address.", BASE), 404);
      }

      if (!suffix && req.method === "GET") return html(runPage(run, o.canResearch, BASE));
      if (suffix === ".json" && req.method === "GET") {
        return new Response(JSON.stringify(run, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
        });
      }
      if (suffix === "/download" && req.method === "GET") {
        if (!run.race || run.status !== "done") {
          return html(
            messagePage("Not ready", "This race hasn't finished researching yet.", BASE),
            409,
          );
        }
        const name = slug(`${run.query.city}-${run.query.office}-${run.query.electionDate}`);
        return html(renderRace(run.race), 200, {
          "content-disposition": `attachment; filename="${name}.html"`,
        });
      }
      if (suffix === "/rerun" && req.method === "POST") {
        if (!o.canResearch) return researchOff();
        const values: FormValues = {
          ...DEFAULT_FORM,
          city: run.query.city,
          state: run.query.state,
          office: run.query.office,
          election: run.query.electionDate,
        };
        return await start(run.query, run.candidates, values, run.candidate_source ?? null);
      }
      return html(messagePage("Not allowed", "That action isn't available here.", BASE), 405);
    }

    return html(messagePage("Not found", "There's nothing at that address.", BASE), 404);
  };
}
