/**
 * The Ballot Fix web app. Plain HTML forms and server-rendered pages: no
 * client JavaScript, so the strict CSP from render.ts applies everywhere.
 *
 * Routes:
 *   GET  /                      home: new-race form and saved races
 *   POST /races                 start a race, then redirect to it
 *   GET  /races/:id             race page (refreshes itself while running)
 *   POST /races/:id/rerun       research the same race again
 *   POST /races/:id/choice      save the voter's notes and preliminary pick
 *   GET  /races/:id/download    standalone HTML file of a finished race
 *   GET  /races/:id.json        raw run record
 *   POST /ballots               upload photos/PDF of a ballot, then redirect to it
 *   GET  /ballots/:id           reading progress, then the contests found, for review
 *   POST /ballots/:id/research  start races and measures the user picked
 *   GET  /ballots/:id/researched what has research, in ballot order, with the quick read on each
 *   GET  /ballots/:id/picks     the voter's picks and notes, in ballot order
 *   POST /ballots/:id/picks     save picks and notes (from the sheet, or the ballot page)
 *   GET  /entities              name search over the knowledge graph, one place at a time
 *   GET  /entities/:slug        what the graph holds on one person, organization, office,
 *                               measure, or measure side, across finished runs (read-only)
 *   GET  /healthz
 *   GET  /apple-touch-icon.png  home-screen icon (public, like /healthz)
 */

import { measuresOf, parsePriorities } from "../dossier.ts";
import { nameKey } from "../knowledge.ts";
import {
  CSP,
  type EntityLinks,
  measureTitle,
  renderMeasure,
  renderRace,
  slug,
  titleFor,
  TOUCH_ICON_PATH,
} from "../render.ts";
import {
  entityPage,
  entityView,
  keptRunId,
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  type RunInfo,
  searchPage,
} from "./entities.ts";
import { MAX_PRIORITIES } from "../template.ts";
import type {
  BallotCandidate,
  BallotMediaType,
  BallotPage,
  CandidateSource,
  MeasureQuery,
  RaceQuery,
} from "../types.ts";
import { type BallotJobs, type JobRunner, QueueFullError, type SubmitExtras } from "./jobs.ts";
import {
  ballotPage,
  type BallotWalk,
  choiceOptions,
  DEFAULT_FORM,
  type FormValues,
  type HomeOptions,
  homePage,
  MAX_BALLOT_FILE_BYTES,
  MAX_BALLOT_FILES,
  MAX_BALLOT_TOTAL_BYTES,
  MAX_NOTES,
  messagePage,
  type PickItem,
  picksPage,
  researchedPage,
  runPage,
  withSaved,
} from "./pages.ts";
import {
  type BallotRecord,
  type ChoiceRecord,
  type ChoiceStore,
  isRunId,
  type RunRecord,
  type RunStore,
} from "./store.ts";

export interface AppOptions {
  store: RunStore;
  jobs: JobRunner;
  /** Reads uploaded ballots. Without it, the upload routes are 404s. */
  ballots?: BallotJobs;
  /** Keeps the voter's notes and picks. Without it, there is no notes panel. */
  choices?: ChoiceStore;
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
  "content-security-policy": CSP,
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
 * The ballot-wide issues followed by one contest's own, repeats dropped. Every
 * candidate in that contest gets the combined list in the same words.
 */
export function combinePriorities(
  shared: readonly string[],
  own: readonly string[],
  label: string,
): { ok: true; issues: string[] } | { ok: false; error: string } {
  const seen = new Set(shared.map((s) => s.toLowerCase()));
  const issues = [...shared, ...own.filter((s) => !seen.has(s.toLowerCase()))];
  return issues.length > MAX_PRIORITIES
    ? {
      ok: false,
      error:
        `${label}: up to ${MAX_PRIORITIES} issues in all, counting the ones for your whole ballot.`,
    }
    : { ok: true, issues };
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

export { parsePriorities };

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

/** Key in BallotRecord.started for a measure; contests use their bare index. */
export function measureKey(index: number): string {
  return `m${index}`;
}

type Picked = {
  /** Key in BallotRecord.started. */
  key: string;
  query: RaceQuery;
  candidates: BallotCandidate[] | null;
  source: CandidateSource | null;
  measure?: MeasureQuery;
  /** The ballot-wide issues plus this item's own. */
  priorities: string[];
  vote_for: number | null;
};

/** Only plain digits: "01", "1e0", or "" must not alias another item. */
function pickIndexes(form: FormData, name: string): number[] | null {
  const raw = form.getAll(name).map(String);
  if (raw.some((v) => !/^(0|[1-9]\d{0,3})$/.test(v))) return null;
  return [...new Set(raw.map(Number))];
}

/** Validates the ballot review form: what to research, and the user's corrections. */
export function parseBallotResearch(
  b: BallotRecord,
  form: FormData,
): { ok: true; picks: Picked[] } | { ok: false; error: string } {
  const r = b.reading;
  if (!r) return { ok: false, error: "This ballot hasn't been read." };
  const indexes = pickIndexes(form, "pick");
  const measureIndexes = pickIndexes(form, "pick_measure");
  if (!indexes || !measureIndexes) {
    return { ok: false, error: "That item isn't available to research." };
  }
  if (!indexes.length && !measureIndexes.length) {
    return { ok: false, error: "Choose at least one contest or measure to research." };
  }
  const shared = parsePriorities(field(form, "priorities"));
  if (!shared.ok) return shared;
  /** This item's issues on top of the ballot-wide ones. */
  const issuesFor = (key: string, label: string) => {
    const own = parsePriorities(field(form, `priorities_${key}`));
    if (!own.ok) return { ok: false as const, error: `${label}: ${own.error}` };
    return combinePriorities(shared.issues, own.issues, label);
  };
  const picks: Picked[] = [];
  for (const i of indexes) {
    const contest = r.contests[i];
    if (!contest || b.started[String(i)]) {
      return { ok: false, error: "That item isn't available to research." };
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
    const issues = issuesFor(String(i), label);
    if (!issues.ok) return issues;
    // Keep the designations read from the ballot for names the user didn't change.
    const read = new Map(contest.candidates.map((c) => [c.name.toLowerCase(), c]));
    const edited = parsed.candidates.length !== contest.candidates.length ||
      parsed.candidates.some((c, k) =>
        c.name.toLowerCase() !== contest.candidates[k].name.toLowerCase()
      );
    picks.push({
      key: String(i),
      query: parsed.query,
      candidates: parsed.candidates.map((c) => ({
        ...c,
        ballot_designation: read.get(c.name.toLowerCase())?.ballot_designation ?? null,
      })),
      source: edited ? EDITED_BALLOT_SOURCE : UPLOADED_BALLOT_SOURCE,
      priorities: issues.issues,
      vote_for: contest.vote_for,
    });
  }

  const measures = measuresOf(r);
  for (const i of measureIndexes) {
    const m = measures[i];
    if (!m || b.started[measureKey(i)]) {
      return { ok: false, error: "That item isn't available to research." };
    }
    const label = field(form, `mlabel_${i}`);
    const jurisdiction = field(form, `mjur_${i}`);
    const name = label || m.label || "A measure";
    const issues = issuesFor(measureKey(i), name);
    if (!issues.ok) return issues;
    if (m.kind === "retention") {
      // A retention question is research on one person: a one-candidate race.
      const person = field(form, `mperson_${i}`);
      const parsed = parseRaceForm({
        city: jurisdiction,
        state: field(form, "state"),
        office: label,
        election: field(form, "election"),
        candidates: person,
        incumbent: person,
      });
      if (!parsed.ok) return { ok: false, error: `${name}: ${parsed.error}` };
      if (parsed.candidates?.length !== 1) {
        return { ok: false, error: `${name}: enter the judge's name.` };
      }
      const edited = person.toLowerCase() !== m.person.toLowerCase();
      picks.push({
        key: measureKey(i),
        query: parsed.query,
        candidates: parsed.candidates,
        source: {
          ...(edited ? EDITED_BALLOT_SOURCE : UPLOADED_BALLOT_SOURCE),
          contest_kind: "retention",
        },
        priorities: issues.issues,
        vote_for: 1,
      });
      continue;
    }
    if (!label || label.length > 80) {
      return {
        ok: false,
        error: `${name}: enter the measure's letter or number (up to 80 characters).`,
      };
    }
    if (!jurisdiction || jurisdiction.length > 80) {
      return {
        ok: false,
        error: `${name}: enter the city, county, district, or state that put it on the ballot.`,
      };
    }
    const base = parseRaceForm({
      city: jurisdiction,
      state: field(form, "state"),
      office: label,
      election: field(form, "election"),
      candidates: "",
      incumbent: "",
    });
    if (!base.ok) return { ok: false, error: `${name}: ${base.error}` };
    picks.push({
      key: measureKey(i),
      query: base.query,
      candidates: null,
      source: null,
      measure: {
        label,
        jurisdiction,
        // The question as read stays attached unless the user re-labeled it as a different measure.
        question: label.toLowerCase() === m.label.toLowerCase() ? m.question : "",
        state: base.query.state,
        electionDate: base.query.electionDate,
      },
      priorities: issues.issues,
      vote_for: 1,
    });
  }
  return { ok: true, picks };
}

/** Validates the notes-and-pick form against what can be picked. */
export function parseChoice(
  { options, max }: { options: readonly string[]; max: number },
  form: FormData,
  suffix = "",
): { ok: true; picks: string[]; notes: string } | { ok: false; error: string } {
  const picks = [...new Set(form.getAll(`pick${suffix}`).map(String).filter(Boolean))];
  if (picks.some((p) => !options.includes(p))) {
    return { ok: false, error: "That pick isn't one of the choices for this." };
  }
  if (picks.length > max) {
    return { ok: false, error: `This one is vote for ${max}; pick up to ${max}.` };
  }
  const raw = form.get(`notes${suffix}`);
  const notes = (typeof raw === "string" ? raw : "").replace(/\r\n/g, "\n").trim();
  if (notes.length > MAX_NOTES) {
    return { ok: false, error: `Notes can be up to ${MAX_NOTES} characters.` };
  }
  return { ok: true, picks, notes };
}

async function saveChoice(
  store: ChoiceStore,
  id: string,
  c: { picks: string[]; notes: string },
): Promise<void> {
  const prev = await store.get(id);
  const at = new Date().toISOString();
  await store.save({ id, created_at: prev?.created_at ?? at, updated_at: at, ...c });
}

/** What a ballot item is and what can be picked for it, from the reading. */
export function ballotItem(
  b: BallotRecord,
  key: string,
): { heading: string; detail: string; options: string[]; max: number } | null {
  const r = b.reading;
  if (!r || !/^m?(0|[1-9]\d{0,3})$/.test(key)) return null;
  if (key.startsWith("m")) {
    const m = measuresOf(r)[Number(key.slice(1))];
    if (!m) return null;
    return {
      heading: m.kind === "retention" ? `${m.person || "Judge"} (retention)` : m.label,
      detail: [m.jurisdiction, m.kind === "retention" ? m.label : ""].filter(Boolean).join(" · "),
      options: ["Yes", "No"],
      max: 1,
    };
  }
  const c = r.contests[Number(key)];
  if (!c) return null;
  return {
    heading: c.office,
    detail: [c.jurisdiction, c.vote_for ? `vote for ${c.vote_for}` : ""].filter(Boolean).join(
      " · ",
    ),
    options: c.candidates.map((x) => x.name),
    max: Math.max(1, c.vote_for ?? 1),
  };
}

/** Where notes and a pick for a ballot item live, whether or not it's researched. */
export function ballotChoiceId(ballotId: string, key: string): string {
  return `${ballotId}-${key}`;
}

type SheetChange = { it: PickItem; p: { picks: string[]; notes: string } };

/**
 * The picks and notes posted for a ballot's items, validated all together so
 * an error never half-saves them. Items not on the posted form are left
 * alone, so a page showing only some of them can't clear the rest.
 */
export function parseSheet(
  items: readonly PickItem[],
  form: FormData,
): { ok: true; changes: SheetChange[] } | { ok: false; status: number; error: string } {
  const changes: SheetChange[] = [];
  for (const it of items) {
    const k = `_${it.key}`;
    if (!form.has(`seen${k}`) && !form.has(`pick${k}`) && !form.has(`notes${k}`)) continue;
    const p = parseChoice(
      { options: withSaved(it.options, it.choice?.picks), max: it.max },
      form,
      k,
    );
    if (!p.ok) return { ok: false, status: 400, error: `${it.heading}: ${p.error}` };
    const same = (it.choice?.notes ?? "") === p.notes &&
      JSON.stringify(it.choice?.picks ?? []) === JSON.stringify(p.picks);
    // Saved elsewhere (a research page, another tab) since this page was loaded:
    // writing this page's older copy back would undo that.
    if (!same && field(form, `seen${k}`) !== (it.choice?.updated_at ?? "")) {
      return {
        ok: false,
        status: 409,
        error:
          `${it.heading} was changed somewhere else after you opened this page. Nothing was saved; here is the current version, so redo your changes.`,
      };
    }
    if (!same) changes.push({ it, p });
  }
  return { ok: true, changes };
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
    extras: SubmitExtras = {},
  ) => {
    try {
      const run = await o.jobs.submit(query, candidates, source, extras);
      return redirect(`${BASE}/races/${run.id}`);
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err;
      return html(await home({ values, error: err.message }), 429);
    }
  };
  const choiceFor = async (run: RunRecord): Promise<ChoiceRecord | null> =>
    o.choices ? await o.choices.get(run.choice_id ?? run.id) : null;

  /** Every contest and measure on a ballot, in printed order, with its run and the voter's pick. */
  const pickItems = async (b: BallotRecord): Promise<PickItem[]> => {
    const r = b.reading;
    if (!r) return [];
    const keys = [
      ...r.contests.map((_, i) => String(i)),
      ...measuresOf(r).map((_, i) => measureKey(i)),
    ];
    return await Promise.all(keys.map(async (key): Promise<PickItem> => {
      const it = ballotItem(b, key)!;
      const id = b.started[key];
      const run = id ? await o.store.get(id) : null;
      const choiceId = run ? run.choice_id ?? run.id : ballotChoiceId(b.id, key);
      const choice = o.choices ? await o.choices.get(choiceId) : null;
      // A researched contest may have a corrected candidate list; pick from that.
      const { options, max } = run ? choiceOptions(run) : it;
      return { key, heading: it.heading, detail: it.detail, options, max, run, choice, choiceId };
    }));
  };

  /** A ballot run's place among the ballot's researched items, in ballot order. */
  const walkFor = async (run: RunRecord): Promise<BallotWalk | undefined> => {
    const link = run.ballot;
    const b = link && o.ballots ? await o.ballots.store.get(link.id) : null;
    if (!b?.reading) return undefined;
    const r = b.reading;
    const keys = [
      ...r.contests.map((_, i) => String(i)),
      ...measuresOf(r).map((_, i) => measureKey(i)),
    ].filter((k) => b.started[k]);
    const at = keys.findIndex((k) => b.started[k] === run.id);
    const step = (k: string | undefined) =>
      k ? { href: `${BASE}/races/${b.started[k]}`, label: ballotItem(b, k)?.heading ?? "" } : null;
    return {
      href: `${BASE}/ballots/${b.id}/researched#item-${link!.key}`,
      position: at + 1,
      total: keys.length,
      prev: at > 0 ? step(keys[at - 1]) : null,
      next: at >= 0 ? step(keys[at + 1]) : null,
    };
  };

  /** A finished run's links into entity pages: only entities its own graph share holds. */
  const linksFor = (run: RunRecord): EntityLinks | undefined => {
    if (run.status !== "done") return undefined;
    const slugs = o.store.knowledge.slugsOfRun(run.id);
    if (!slugs.size) return undefined;
    return {
      runId: run.id,
      href: (key) => {
        const s = slugs.get(key);
        return s ? `${BASE}/entities/${s}` : null;
      },
    };
  };

  const runInfo = async (id: string): Promise<RunInfo | null> => {
    const run = await o.store.get(id);
    if (!run) return null;
    const done = run.measure ? run.measure_result : run.race;
    return {
      id: run.id,
      title: run.measure ? measureTitle(run.measure) : titleFor(run.query),
      created_at: run.created_at,
      researched: (done?.generated_at ?? run.created_at).slice(0, 10),
      newer: o.store.newerDone(run),
    };
  };

  /** Read-only views of the knowledge graph. GET only; they spend nothing. */
  const entityRoutes = async (req: Request, path: string, url: URL): Promise<Response | null> => {
    const kb = o.store.knowledge;
    if (path === "/entities") {
      if (req.method !== "GET") {
        return html(messagePage("Not allowed", "That action isn't available here.", BASE), 405);
      }
      const places = kb.places();
      const asked = url.searchParams.get("place") ?? "";
      const scope = places.some((p) => p.scope === asked)
        ? asked
        : places.length === 1
        ? places[0].scope
        : null;
      const typed = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_CHARS);
      // Punctuation alone matches every name; say so by listing the place as for no query.
      const query = nameKey(typed) ? typed : "";
      const results = scope ? kb.search(scope, query) : null;
      // Same-named people kept to one run each are told apart by their run.
      const runOf = new Map<number, RunInfo>();
      for (const e of (results ?? []).slice(0, MAX_SEARCH_RESULTS)) {
        const id = keptRunId(e);
        const info = id ? await runInfo(id) : null;
        if (info) runOf.set(e.id, info);
      }
      return html(searchPage({ places, scope, query, results, runOf, base: BASE }));
    }
    const m = path.match(/^\/entities\/([^/]+)$/);
    if (!m) return null;
    if (req.method !== "GET") {
      return html(messagePage("Not allowed", "That action isn't available here.", BASE), 405);
    }
    const e = kb.bySlug(m[1]);
    if (!e) {
      return html(
        messagePage(
          "Not found",
          "Nothing in finished research is at that address. It may have come from a run that was researched again or failed.",
          BASE,
        ),
        404,
      );
    }
    return html(entityPage(await entityView(kb, runInfo, e), BASE));
  };

  const researchOff = () =>
    html(messagePage("Research is off", "ANTHROPIC_API_KEY isn't set on the server.", BASE), 503);

  const ballotRoutes = async (
    req: Request,
    path: string,
    url: URL,
  ): Promise<Response | null> => {
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

    const m = path.match(/^\/ballots\/([^/]+?)(\/research|\/researched|\/picks)?$/);
    if (!m) return null;
    const [, id, suffix] = m;
    const b = isRunId(id) ? await ballots.store.get(id) : null;
    if (!b) {
      return html(messagePage("Not found", "There's no saved ballot at that address.", BASE), 404);
    }
    const view = async (rec: BallotRecord = b, items?: PickItem[]) => ({
      canResearch: o.canResearch,
      available: o.jobs.available,
      base: BASE,
      choices: Boolean(o.choices),
      items: items ?? await pickItems(rec),
    });

    if (!suffix && req.method === "GET") {
      return html(ballotPage(b, { ...await view(), saved: url.searchParams.has("saved") }));
    }
    if (suffix === "/researched" && req.method === "GET") {
      if (!b.reading) return html(ballotPage(b, await view()));
      const items = await pickItems(b);
      // Entity keys of contributors carry their run, so links come from every run shown.
      const slugs = new Map(
        items.flatMap((x) =>
          x.run?.status === "done" ? [...o.store.knowledge.slugsOfRun(x.run.id)] : []
        ),
      );
      return html(researchedPage(b, items, {
        base: BASE,
        entityHref: (key) => {
          const s = slugs.get(key);
          return s ? `${BASE}/entities/${s}` : null;
        },
      }));
    }
    if (suffix === "/picks" && req.method === "GET") {
      return html(picksPage(b, await pickItems(b), BASE, { saved: url.searchParams.has("saved") }));
    }
    if (suffix === "/picks" && req.method === "POST" && o.choices) {
      const form = await req.formData();
      const items = await pickItems(b);
      // Posted from the ballot page's "Save" button: answer there.
      const fromBallot = url.searchParams.get("from") === "ballot";
      const parsed = parseSheet(items, form);
      if (!parsed.ok) {
        // On a conflict, show the current version rather than the stale typing.
        const keep = parsed.status === 409 ? undefined : form;
        return html(
          fromBallot
            ? ballotPage(b, { ...await view(b, items), form: keep, error: parsed.error })
            : picksPage(b, items, BASE, { error: parsed.error, form: keep }),
          parsed.status,
        );
      }
      for (const { it, p } of parsed.changes) await saveChoice(o.choices, it.choiceId, p);
      return redirect(`${BASE}/ballots/${b.id}${fromBallot ? "" : "/picks"}?saved=1`);
    }
    if (suffix === "/research" && req.method === "POST") {
      if (!o.canResearch) return researchOff();
      const form = await req.formData();
      // One start at a time per ballot, so a double-click or a second tab can't
      // start (and pay for) the same contest twice. Checked and taken with no
      // await in between; the record is re-read under the lock.
      if (starting.has(b.id)) {
        return html(
          ballotPage(b, {
            ...await view(),
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
        // Picks and notes typed on the same page are saved along with starting research.
        const items = o.choices ? await pickItems(fresh) : undefined;
        const sheet = o.choices && items
          ? parseSheet(items, form)
          : { ok: true as const, changes: [] };
        if (!sheet.ok && sheet.status === 409) {
          // Same as the picks page: show the current version, not the stale typing,
          // or resubmitting it would overwrite what was saved elsewhere.
          return html(ballotPage(fresh, { ...await view(fresh, items), error: sheet.error }), 409);
        }
        if (!sheet.ok) error ??= sheet.error;
        if (!parsed.ok || error) {
          return html(
            ballotPage(fresh, { ...await view(fresh, items), form, error: error ?? undefined }),
            400,
          );
        }
        if (o.choices && sheet.ok) {
          for (const { it, p } of sheet.changes) await saveChoice(o.choices, it.choiceId, p);
        }
        const started = { ...fresh.started };
        let last = "";
        let updated = fresh;
        try {
          for (const p of parsed.picks) {
            const run = await o.jobs.submit(p.query, p.candidates, p.source, {
              priorities: p.priorities,
              measure: p.measure,
              ballot: { id: fresh.id, key: p.key, vote_for: p.vote_for },
              choiceId: ballotChoiceId(fresh.id, p.key),
            });
            started[p.key] = run.id;
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
        if (error) return html(ballotPage(updated, { ...await view(updated), form, error }), 429);
        return redirect(
          parsed.picks.length === 1
            ? `${BASE}/races/${last}`
            : `${BASE}/ballots/${b.id}/researched`,
        );
      } finally {
        starting.delete(b.id);
      }
    }
    return html(messagePage("Not allowed", "That action isn't available here.", BASE), 405);
  };

  let touchIcon: Promise<Uint8Array<ArrayBuffer>> | undefined;

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
    // Before the password check: iOS fetches this without credentials.
    if (path === TOUCH_ICON_PATH && req.method === "GET") {
      touchIcon ??= Deno.readFile(new URL("../../static/apple-touch-icon.png", import.meta.url));
      return new Response(await touchIcon, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
          ...SECURITY_HEADERS,
        },
      });
    }

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

    const ballotResponse = await ballotRoutes(req, path, url);
    if (ballotResponse) return ballotResponse;

    const entityResponse = await entityRoutes(req, path, url);
    if (entityResponse) return entityResponse;

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
        priorities: field(form, "priorities"),
      };
      const parsed = parseRaceForm(values);
      if (!parsed.ok) return html(await home({ values, error: parsed.error }), 400);
      const priorities = parsePriorities(values.priorities ?? "");
      if (!priorities.ok) return html(await home({ values, error: priorities.error }), 400);
      return await start(parsed.query, parsed.candidates, values, null, {
        priorities: priorities.issues,
      });
    }

    const m = path.match(/^\/races\/([^/]+?)(\.json|\/rerun|\/download|\/choice)?$/);
    if (m) {
      const [, id, suffix] = m;
      const run = isRunId(id) ? await o.store.get(id) : null;
      if (!run) {
        return html(messagePage("Not found", "There's no saved race at that address.", BASE), 404);
      }

      const view = async (extra: { saved?: boolean } = {}) =>
        runPage(run, o.canResearch, BASE, {
          choices: Boolean(o.choices),
          choice: await choiceFor(run),
          walk: await walkFor(run),
          links: linksFor(run),
          ...extra,
        });
      if (!suffix && req.method === "GET") {
        return html(await view({ saved: url.searchParams.has("saved") }));
      }
      if (suffix === "/choice" && req.method === "POST" && o.choices) {
        const { options, max } = choiceOptions(run);
        const prev = await choiceFor(run);
        const parsed = parseChoice(
          { options: withSaved(options, prev?.picks), max },
          await req.formData(),
        );
        if (!parsed.ok) {
          return html(messagePage("Not saved", parsed.error, BASE), 400);
        }
        await saveChoice(o.choices, run.choice_id ?? run.id, parsed);
        return redirect(`${BASE}/races/${run.id}?saved=1#mine`);
      }
      if (suffix === ".json" && req.method === "GET") {
        return new Response(JSON.stringify(run, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
        });
      }
      if (suffix === "/download" && req.method === "GET") {
        const ready = run.status === "done" && (run.measure ? run.measure_result : run.race);
        if (!ready) {
          return html(
            messagePage("Not ready", "This hasn't finished researching yet.", BASE),
            409,
          );
        }
        const name = slug(`${run.query.city}-${run.query.office}-${run.query.electionDate}`);
        const file = run.measure && run.measure_result
          ? renderMeasure(run.measure_result)
          : renderRace(run.race!);
        return html(file, 200, {
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
        const res = await start(run.query, run.candidates, values, run.candidate_source ?? null, {
          priorities: run.priorities,
          measure: run.measure ?? undefined,
          choiceId: run.choice_id ?? run.id,
          ballot: run.ballot,
        });
        // Point the ballot (and its picks sheet) at the new run.
        const next = res.headers.get("location")?.split("/").pop();
        const link = run.ballot;
        // Wait out a contest start on the same ballot (it holds the lock only briefly).
        for (let i = 0; link && starting.has(link.id) && i < 100; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (res.status === 303 && next && link && o.ballots && !starting.has(link.id)) {
          // Same per-ballot lock as starting contests, so neither write loses the other's.
          starting.add(link.id);
          try {
            const b = await o.ballots.store.get(link.id);
            if (b && b.started[link.key] === run.id) {
              await o.ballots.store.save({
                ...b,
                started: { ...b.started, [link.key]: next },
                updated_at: new Date().toISOString(),
              });
            }
          } finally {
            starting.delete(link.id);
          }
        }
        return res;
      }
      return html(messagePage("Not allowed", "That action isn't available here.", BASE), 405);
    }

    return html(messagePage("Not found", "There's nothing at that address.", BASE), 404);
  };
}
