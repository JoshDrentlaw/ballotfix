/**
 * Election results (roadmap item 19): the official counts for each item on a
 * read ballot, from the bodies that count them. No model.
 *
 * Two sources, California only for now:
 * - the Secretary of State's results feed (api.sos.ca.gov/returns/...), JSON,
 *   for every statewide and district contest: whole-contest totals;
 * - the county's results page, for local contests and measures, and as a
 *   fallback for a statewide contest the feed couldn't give (then marked as
 *   that county's count only). San Bernardino County's for now (COUNTY_PAGES).
 *
 * An item is matched to a count by its own words only: a candidate contest by
 * every candidate's name (given and last names, initials and nicknames
 * aside), a proposition by its number, a retention question by the judge's
 * name, a local measure by its label and its place. Anything that doesn't
 * match one count exactly is listed with why, never guessed.
 *
 * Counts change until the count is certified, so each read is kept when it
 * differs from the last one (`fingerprint`), with the source's own time and
 * status, and the pages say they're unofficial until certification. No
 * winner is ever named: the source names none until it certifies, and the
 * choices stay in ballot order.
 */

import { createHash } from "node:crypto";
import { measuresOf } from "./dossier.ts";
import { jurisdictionKey, nameKey } from "./knowledge.ts";
import type { BallotReading } from "./types.ts";

export const SOS_BASE = "https://api.sos.ca.gov/returns";
export const SOS_NAME = "California Secretary of State";
/** Most feeds read for one ballot: a bound on requests, said when reached. */
export const MAX_SOS_FEEDS = 30;
/** A results page or feed larger than this is not read. */
export const MAX_RESULTS_BYTES = 8 * 1024 * 1024;
export const RESULTS_TIMEOUT_MS = 30_000;

/** Days after the election by which each source certifies (Cal. Elections Code 15372, 15501). */
export const COUNTY_CERTIFY_DAYS = 30;
export const STATE_CERTIFY_DAYS = 38;
/** Checks go on this long after the later certification date, to catch the certified count. */
export const CHECK_AFTER_CERTIFY_DAYS = 7;

/** County results pages by county name: the page for an election date (YYYYMMDD). */
export const COUNTY_PAGES: Record<string, { name: string; url: (date: string) => string }> = {
  "san bernardino": {
    name: "San Bernardino County Registrar of Voters",
    url: (d) => `https://results.rov.sbcounty.gov/Results/${d}/`,
  },
};

export interface ResultChoice {
  /** As the source writes it. */
  name: string;
  votes: number;
  /** As the source states it; null when it states none. */
  percent: number | null;
}

/** One contest's count as one source states it. */
export interface ContestCount {
  source: "state" | "county";
  source_name: string;
  source_url: string;
  /** The contest as the source titles it. */
  contest: string;
  /** "100.0% (23,860 of 23,860) precincts reporting", as stated. */
  reporting: string | null;
  /** The source's own time or report number for this count, as stated. */
  as_of: string | null;
  /** The source's own words on the count's standing ("Final Unofficial Election Night Results"). */
  status: string | null;
  /** Candidates, or YES and NO, in the source's order. */
  choices: ResultChoice[];
}

/** A ballot item's count as the page shows it. */
export interface ItemResult {
  /** The ballot item: a contest index, or "m" and a measure index. */
  item: string;
  count: ContestCount;
  /** For each ballot choice in ballot order, the source's choice it is (an index), or null. */
  order: (number | null)[];
  /** True when a statewide or district contest's count is only one county's. */
  partial: boolean;
  /** When it was read (the first read of this same count). */
  read_at: string;
}

/** A ballot item with no count, and why. */
export interface Unmatched {
  item: string;
  why: string;
}

/** One check of a ballot: what was read, what matched, and what couldn't be read. */
export interface ResultsCheck {
  checked_at: string;
  matched: ItemResult[];
  unmatched: Unmatched[];
  /** Sources that couldn't be read, each with why. */
  errors: { source: string; url: string; why: string }[];
}

/** Reads a URL's text. Implemented over fetch by `fetchText`; tests pass their own. */
export type Fetcher = (url: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,%\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null;

/**
 * One Secretary of State feed: a candidate contest ("candidates"), the
 * ballot measures (one count per proposition), or retention questions (one
 * per judge). Anything else in it is ignored; a malformed row is skipped.
 */
export function parseSosFeed(json: unknown, url: string): ContestCount[] {
  if (!json || typeof json !== "object") return [];
  const d = json as Record<string, unknown>;
  const title = text(d.raceTitle) ?? "";
  const base = {
    source: "state" as const,
    source_name: SOS_NAME,
    source_url: url,
    reporting: text(d.Reporting),
    as_of: text(d.ReportingTime),
    status: null,
  };
  const rows = (k: string) => (Array.isArray(d[k]) ? d[k] as Record<string, unknown>[] : []);
  const yesNo = (r: Record<string, unknown>) => {
    const yes = num(r.yesVotes), no = num(r.noVotes);
    return yes === null || no === null ? null : [
      { name: "YES", votes: yes, percent: num(r.yesPercent) },
      { name: "NO", votes: no, percent: num(r.noPercent) },
    ];
  };
  const out: ContestCount[] = [];
  if (Array.isArray(d.candidates)) {
    const choices = rows("candidates").flatMap((r) => {
      const name = text(r.Name), votes = num(r.Votes);
      return name && votes !== null ? [{ name, votes, percent: num(r.Percent) }] : [];
    });
    if (choices.length) out.push({ ...base, contest: title, choices });
  }
  for (const r of rows("ballot-measures")) {
    const n = text(r.Number), choices = yesNo(r);
    if (!n || !choices) continue;
    out.push({ ...base, contest: `Proposition ${Number(n)}: ${text(r.Name) ?? ""}`, choices });
  }
  for (const k of Object.keys(d)) {
    if (k === "ballot-measures" || k === "candidates" || !Array.isArray(d[k])) continue;
    // Retention lists ("supreme-court", "courts-of-appeal"): one judge per row.
    for (const r of rows(k)) {
      const name = text(r.Name), choices = yesNo(r);
      if (name && choices) out.push({ ...base, contest: `${title}: ${name}`, choices });
    }
  }
  return out;
}

const decode = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const flat = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * A county results page in the layout San Bernardino County's uses (one
 * heading per contest, then a table of choice, party, votes, percent). The
 * page's status, report number, and next update are taken as stated.
 */
export function parseCountyPage(html: string, url: string, sourceName: string): ContestCount[] {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  const head = flat(body.slice(0, body.search(/<h2[\s>]/i) >>> 0 || 200_000));
  const status = /\b((?:Final |Semi-?)?(?:Unofficial|Official|Certified)[\w -]{0,60}?Results)\b/i
    .exec(head)?.[1] ?? null;
  const report = /Summary Report #\s*(\d+)/i.exec(flat(body.slice(0, 400_000)))?.[1];
  const next = /Next Update:\s*(.{1,60}?(?:\d{4}(?: By [\d:]+ ?[ap]\.?m\.?)?))/i.exec(head)?.[1];
  const as_of = [report ? `Summary Report #${report}` : "", next ? `next update ${next}` : ""]
    .filter(Boolean).join("; ") || null;
  const out: ContestCount[] = [];
  const parts = body.split(/<h2[^>]*>/i).slice(1);
  for (const part of parts) {
    const end = part.search(/<\/h2>/i);
    if (end < 0) continue;
    const contest = flat(part.slice(0, end));
    const rest = part.slice(end);
    const reporting = /Precincts Reported:\s*([\d,]+ of [\d,]+ \([\d.]+%\))/i.exec(flat(
      rest.slice(0, 2000),
    ))?.[1] ?? null;
    // The choices' table: rows of name, party, votes, percent, up to "Total Votes".
    const table = /<table[^>]*id="electionContests\d+"[^>]*>([\s\S]*?)<\/table>/i.exec(rest)?.[1];
    if (!table) continue;
    const choices: ResultChoice[] = [];
    for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => flat(c[1]));
      if (cells.length < 3 || /^total/i.test(cells[0])) continue;
      const votes = num(cells[cells.length - 2]), percent = num(cells[cells.length - 1]);
      if (cells[0] && votes !== null) choices.push({ name: cells[0], votes, percent });
    }
    if (choices.length) {
      out.push({
        source: "county",
        source_name: sourceName,
        source_url: url,
        contest,
        reporting: reporting ? `${reporting} precincts reported` : null,
        as_of,
        status,
        choices,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which feeds a ballot needs
// ---------------------------------------------------------------------------

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

/** "Fourth District", "4th Appellate District", "District 4": 4. */
export function districtOf(s: string): number | null {
  const m = /(?:district\s+(\d+))|(?:(\d+)(?:st|nd|rd|th)\s+(?:appellate\s+)?district)/i.exec(s);
  if (m) return Number(m[1] ?? m[2]);
  const w = new RegExp(`\\b(${ORDINALS.join("|")})\\s+(?:appellate\\s+)?district`, "i").exec(s);
  return w ? ORDINALS.indexOf(w[1].toLowerCase()) + 1 : null;
}

/** Statewide offices by their words, to their feed. */
const STATEWIDE: [RegExp, string][] = [
  [/^governor$/, "governor"],
  [/^lieutenant governor$/, "lieutenant-governor"],
  [/^secretary of state$/, "secretary-of-state"],
  [/^controller$/, "controller"],
  [/^treasurer$/, "treasurer"],
  [/^attorney general$/, "attorney-general"],
  [/^insurance commissioner$/, "insurance-commissioner"],
  [/^superintendent of public instruction$/, "superintendent-of-public-instruction"],
  [/^united states senator$|^u s senator$/, "us-senate"],
];

/** The feed for a state or district office, from its title; null for any other. */
export function sosPathFor(office: string, jurisdiction: string): string | null {
  const o = nameKey(office).replace(/^(member|member of the)\s+/, "").trim();
  const state = /^(state|california|state of california|state offices?)$/i
    .test(jurisdiction.trim()) || /\bstate\b/i.test(jurisdiction);
  for (const [re, path] of STATEWIDE) {
    // "Treasurer" alone is the state's only when the ballot puts it under the state.
    if (re.test(o) && (path !== "treasurer" && path !== "controller" || state)) return path;
  }
  const d = districtOf(office);
  if (d === null) return null;
  if (/representative|congress/.test(o)) return `us-rep/district/${d}`;
  if (/state assembly|assembly/.test(o)) return `state-assembly/district/${d}`;
  if (/state senate|senate/.test(o)) return `state-senate/district/${d}`;
  if (/board of equalization/.test(o)) return `board-of-equalization/district/${d}`;
  return null;
}

/** The feed for a retention question's court: the Supreme Court, or a Court of Appeal district. */
export function retentionPath(label: string): string | null {
  if (/supreme court/i.test(label)) return "supreme-court";
  if (/court of appeal/i.test(label)) {
    const d = districtOf(label);
    return d ? `courts-of-appeal/district/${d}` : null;
  }
  return null;
}

/** Every Secretary of State feed a ballot's items could be in, at most MAX_SOS_FEEDS. */
export function sosPaths(r: BallotReading): string[] {
  const paths = new Set<string>();
  for (const c of r.contests) {
    const p = sosPathFor(c.office, c.jurisdiction);
    if (p) paths.add(p);
  }
  for (const m of measuresOf(r)) {
    if (m.kind === "retention") {
      const p = retentionPath(m.label);
      if (p) paths.add(p);
    } else if (isStateMeasure(m.label, m.jurisdiction)) paths.add("ballot-measures");
  }
  return [...paths].slice(0, MAX_SOS_FEEDS);
}

const propNumber = (label: string) => /^\s*prop(?:osition)?\.?\s*(\d+)\s*$/i.exec(label)?.[1];
const isStateMeasure = (label: string, jurisdiction: string) =>
  !!propNumber(label) && (!jurisdiction || /state|california/i.test(jurisdiction));

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * A person's name for matching: given and last names, without initials,
 * nicknames in quotes or brackets, or suffixes. "DONALD P. (DON) WAGNER" and
 * "Donald P. Wagner" are one; "HERB W MORGAN" and "Herb Morgan" too.
 */
export function personKey(name: string): string {
  const bare = name.replace(/\([^)]*\)|"[^"]*"|“[^”]*”/g, " ");
  return nameKey(bare).split(" ")
    .filter((w) => w.length > 1 && !["jr", "sr", "ii", "iii", "iv"].includes(w)).join(" ");
}

const isYesNo = (c: ContestCount) =>
  c.choices.length === 2 && c.choices.map((x) => x.name.toUpperCase()).join() === "YES,NO";

/** Each ballot name's choice in the count, or null where none matches exactly once. */
function orderFor(names: readonly string[], count: ContestCount): (number | null)[] {
  const keys = count.choices.map((c) => personKey(c.name));
  return names.map((n) => {
    const k = personKey(n);
    const at = keys.flatMap((x, i) => (x === k ? [i] : []));
    return at.length === 1 ? at[0] : null;
  });
}

/** The one count whose choices hold every ballot name; null when none or several do. */
function byNames(names: readonly string[], counts: readonly ContestCount[]) {
  const fits = counts.filter((c) => !isYesNo(c)).map((c) => ({ c, order: orderFor(names, c) }))
    .filter((x) => x.order.every((i) => i !== null) && new Set(x.order).size === names.length);
  return fits.length === 1 ? fits[0] : fits.length ? "several" as const : null;
}

/**
 * Matches a ballot's items to counts: the state's first for anything it
 * covers, then the county's. Every item gets a count or a reason.
 */
export function matchResults(
  r: BallotReading,
  state: readonly ContestCount[],
  county: readonly ContestCount[],
  read_at: string,
  why: { state?: string; county?: string } = {},
): { matched: ItemResult[]; unmatched: Unmatched[] } {
  const matched: ItemResult[] = [];
  const unmatched: Unmatched[] = [];
  const add = (item: string, count: ContestCount, order: (number | null)[], partial: boolean) =>
    matched.push({ item, count, order, partial, read_at });
  const missing = (whose: "state" | "county") => why[whose] ? ` (${why[whose]})` : "";

  r.contests.forEach((c, i) => {
    const item = String(i);
    const names = c.candidates.map((x) => x.name);
    if (!names.length) return unmatched.push({ item, why: "the ballot lists no candidates" });
    const statewide = sosPathFor(c.office, c.jurisdiction) !== null;
    const s = statewide ? byNames(names, state) : null;
    if (s && s !== "several") return add(item, s.c, s.order, false);
    const k = byNames(names, county);
    if (k && k !== "several") return add(item, k.c, k.order, statewide);
    unmatched.push({
      item,
      why: s === "several" || k === "several"
        ? "more than one contest lists all of its candidates"
        : statewide
        ? `no count lists all of its candidates${missing("state")}`
        : `no count on the county's page lists all of its candidates${missing("county")}`,
    });
  });

  measuresOf(r).forEach((m, i) => {
    const item = `m${i}`;
    const yn = (
      c: ContestCount,
    ) => [
      c.choices.findIndex((x) => /^yes$/i.test(x.name)),
      c.choices.findIndex((x) => /^no$/i.test(x.name)),
    ];
    const one = (cs: ContestCount[]) => (cs.length === 1 ? cs[0] : cs.length ? "several" : null);
    if (m.kind === "retention") {
      const k = personKey(m.person);
      const has = (c: ContestCount) =>
        isYesNo(c) && k !== "" && personKey(c.contest.split(/[:(]/).slice(1).join(" ")) === k ||
        isYesNo(c) && new RegExp(`\\(${escRe(m.person.trim())}\\)`, "i").test(c.contest);
      const s = one(state.filter(has));
      if (s && s !== "several") return add(item, s, yn(s), false);
      const c = one(county.filter(has));
      if (c && c !== "several") return add(item, c, yn(c), true);
      return unmatched.push({
        item,
        why: s === "several" || c === "several"
          ? "more than one count names this judge"
          : `no count names this judge${missing("state")}`,
      });
    }
    const n = propNumber(m.label);
    if (n && isStateMeasure(m.label, m.jurisdiction)) {
      const has = (c: ContestCount) =>
        isYesNo(c) && new RegExp(`^prop(?:osition)?\\s*0*${Number(n)}(?!\\d)`, "i")
          .test(c.contest.replace(/^.*?(?=prop)/i, ""));
      const s = one(state.filter((c) => has(c)));
      if (s && s !== "several") return add(item, s, yn(s), false);
      const c = one(county.filter((c) => has(c) && /\bPROPOSITION\b/i.test(c.contest)));
      if (c && c !== "several") return add(item, c, yn(c), true);
      return unmatched.push({ item, why: `no count for ${m.label}${missing("state")}` });
    }
    // A local measure: its label whole-word, in its place when more than one place has it.
    const label = new RegExp(`(?<![\\p{L}\\p{N}])${escRe(m.label.trim())}(?![\\p{L}\\p{N}])`, "iu");
    const withLabel = county.filter((c) => isYesNo(c) && label.test(c.contest));
    const place = jurisdictionKey(m.jurisdiction);
    const here = withLabel.length > 1
      ? withLabel.filter((c) => place && nameKey(c.contest).includes(place))
      : withLabel;
    const c = one(here);
    if (c && c !== "several") return add(item, c, yn(c), false);
    unmatched.push({
      item,
      why: c === "several"
        ? `more than one count is ${m.label} in ${m.jurisdiction || "its place"}`
        : `no count on the county's page is ${m.label}${missing("county")}`,
    });
  });
  return { matched, unmatched };
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The choices an item's count is matched against, in ballot order: the
 * candidates as read from the ballot, or Yes and No. `ItemResult.order` is by these.
 */
export function resultNames(r: BallotReading, item: string): string[] {
  if (item.startsWith("m")) return measuresOf(r)[Number(item.slice(1))] ? ["Yes", "No"] : [];
  return (r.contests[Number(item)]?.candidates ?? []).map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** GET a URL's text, with a timeout and a size cap; throws with a plain reason. */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "ballotfix (personal election results reader)" },
    signal: AbortSignal.timeout(RESULTS_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_RESULTS_BYTES) {
    await res.body?.cancel();
    throw new Error(`larger than ${MAX_RESULTS_BYTES} bytes`);
  }
  const body = await res.text();
  if (body.length > MAX_RESULTS_BYTES) throw new Error(`larger than ${MAX_RESULTS_BYTES} bytes`);
  return body;
}

/** When each source certifies, from the election date: ISO dates. */
export function certifyDates(electionDate: string): { county: string; state: string } | null {
  const d = new Date(`${electionDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const plus = (n: number) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  return { county: plus(COUNTY_CERTIFY_DAYS), state: plus(STATE_CERTIFY_DAYS) };
}

/** Whether a ballot's results are still worth reading on a schedule at `now`. */
export function inCountWindow(r: BallotReading, now: Date): boolean {
  if (!r.election_date || (r.state && r.state.toUpperCase() !== "CA")) return false;
  const dates = certifyDates(r.election_date);
  if (!dates) return false;
  const start = new Date(`${r.election_date}T00:00:00Z`).getTime();
  const end = new Date(`${dates.state}T00:00:00Z`).getTime() +
    CHECK_AFTER_CERTIFY_DAYS * 86_400_000;
  return now.getTime() >= start && now.getTime() <= end;
}

/**
 * Reads every source a ballot needs and matches its items. A source that
 * can't be read is an error on the check and a reason on its items; the
 * other source is still used.
 */
export async function checkResults(
  r: BallotReading,
  fetcher: Fetcher,
  now: Date,
): Promise<ResultsCheck> {
  const read_at = now.toISOString();
  const errors: ResultsCheck["errors"] = [];
  const isCA = !r.state || r.state.toUpperCase() === "CA";
  if (!isCA || !r.election_date) {
    const why = !isCA
      ? "results are only read for California ballots so far"
      : "the ballot's election date couldn't be read";
    return {
      checked_at: read_at,
      matched: [],
      unmatched: [
        ...r.contests.map((_, i) => ({ item: String(i), why })),
        ...measuresOf(r).map((_, i) => ({ item: `m${i}`, why })),
      ],
      errors: [],
    };
  }
  const state: ContestCount[] = [];
  let stateWhy: string | undefined;
  for (const p of sosPaths(r)) {
    const url = `${SOS_BASE}/${p}`;
    try {
      state.push(...parseSosFeed(JSON.parse(await fetcher(url)), url));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      errors.push({ source: SOS_NAME, url, why });
      stateWhy = "the Secretary of State's feed couldn't be read";
    }
  }
  const county: ContestCount[] = [];
  let countyWhy: string | undefined;
  const page = COUNTY_PAGES[nameKey(r.county ?? "").replace(/ county$/, "")];
  if (!page) countyWhy = `no results page is set up for ${r.county ?? "this"} County yet`;
  else {
    const url = page.url(r.election_date.replaceAll("-", ""));
    try {
      county.push(...parseCountyPage(await fetcher(url), url, page.name));
      if (!county.length) throw new Error("no contests could be read from it");
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      errors.push({ source: page.name, url, why });
      countyWhy = "the county's page couldn't be read";
    }
  }
  const { matched, unmatched } = matchResults(r, state, county, read_at, {
    state: stateWhy,
    county: countyWhy,
  });
  return { checked_at: read_at, matched, unmatched, errors };
}

/** What makes two reads the same count: kept once, at its first read. */
export function fingerprint(c: ContestCount): string {
  return createHash("sha256").update(JSON.stringify([
    c.source,
    c.source_url,
    c.contest,
    c.reporting,
    c.as_of,
    c.status,
    c.choices,
  ])).digest("hex");
}
