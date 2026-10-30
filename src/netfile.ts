/**
 * NetFile: a deterministic primary-record adapter for campaign finance, for
 * the California cities and counties whose filings are on NetFile.
 *
 * Instead of a model reading contributions off filings, the rows come from
 * NetFile's public transaction search (Form 460 Schedules A and C, Form 497
 * Part 1; current filings only), field by field, with no model in between.
 * NetFile retired the per-year CAL export this first read; the search's rows
 * are put in the same CAL field names (fromSearch). That removes the
 * transcription risk, and the per-subject cap becomes a bound on the page
 * (MAX_EXPORT_PER_SUBJECT) rather than on what a call can read.
 *
 * - The place must match one NetFile agency: by BALLOTFIX_NETFILE_AGENCIES,
 *   else by name in NetFile's agency list (jurisdictionKey). Anywhere else, or
 *   when the export can't be read, or when no subject's committee is found,
 *   the model lookup runs instead (the fallback), for every subject alike.
 * - A committee is matched to a candidate only by a name holding the
 *   candidate's first and last name (or the surname with this race's office
 *   and the election's year), never a recall or opposing committee,
 *   never a committee of another type, never one named for another year's
 *   election; to a measure's side only by a name holding the measure's label
 *   and words of one side only. A committee that matches two subjects goes to
 *   neither. Every subject left unmatched gets a gap note saying how it was
 *   looked for. Matching is local and deterministic, and the page lists the
 *   committees each subject's rows came from.
 * - Rows keep the export's own fields. Provenance is the export's URL (what
 *   was retrieved) and the filing (its id, and its image on NetFile).
 *   src/finance.ts checks every row as it does a model's.
 *
 * Calls only netfile.com (or a client's own base). Nothing about the
 * candidates is sent: the export is the agency's whole year.
 */

import { jurisdictionKey, nameKey } from "./knowledge.ts";
import { MAX_EXPORT_PER_SUBJECT } from "./finance.ts";
import type {
  FinanceRequest,
  FinanceResearcher,
  FinanceSubject,
  RawContribution,
  RawFinanceResult,
  RawFinanceSubject,
  RawPortalGap,
} from "./types.ts";

export const NETFILE_BASE = "https://netfile.com/Connect2/api";
/** Rows per export page, and most pages read per year: a bound on time, said when reached. */
export const NETFILE_PAGE_SIZE = 1000;
export const NETFILE_MAX_PAGES = 40;
const TIMEOUT_MS = 60_000;
/** How long one agency's year export is reused by a client before it is read again. */
export const EXPORT_CACHE_MS = 60 * 60_000;

export interface NetFileAgency {
  /** NetFile's agency id ("shortcut"), e.g. "COAK". */
  id: string;
  name: string;
  /** NetFile's agency number, which its transaction search takes; from the agency list. */
  number?: number;
}

/** One transaction row, keys normalized (lowercase, letters and digits only). */
export type ExportRow = Record<string, unknown>;

export interface ExportYear {
  year: number;
  /** The export's URL for the year: the row's source, and what counts as retrieved. */
  url: string;
  rows: ExportRow[];
  /**
   * Every committee with a row of any kind that year, so one that filed but
   * listed no contributions is still found. Absent: the rows' filers.
   */
  filers?: Filer[];
  /** Pages stopped at NETFILE_MAX_PAGES before the export ended. */
  truncated: boolean;
}

/** What the adapter reads from NetFile: the agency list and one agency's year. */
export interface NetFileSource {
  agencies(): Promise<NetFileAgency[]>;
  transactions(agency: string, year: number): Promise<ExportYear>;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const keyOf = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

function normalizeRow(o: unknown): ExportRow | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [keyOf(k), v]));
}

/** The first of several names a field goes by, as a trimmed string. */
function get(row: ExportRow, ...names: string[]): string {
  for (const n of names) {
    const v = row[n];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** An array in a JSON answer, bare or under one of the usual keys. */
function arrayIn(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const o = (json ?? {}) as Record<string, unknown>;
  for (const k of ["results", "items", "agencies", "transactions", "data"]) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

/** NetFile's public API over fetch. The agency list is read once per client. */
export class NetFileClient implements NetFileSource {
  readonly #fetch: Fetch;
  readonly #base: string;
  #agencies: Promise<NetFileAgency[]> | null = null;
  /** Per agency and year, so a ballot's items in one place read its export once. */
  readonly #years = new Map<string, { at: number; got: Promise<ExportYear> }>();
  /** Per agency: its committees, read once with its first year. */
  readonly #filers = new Map<string, Promise<Filer[]>>();

  constructor(opts: { fetch?: Fetch; base?: string } = {}) {
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i));
    this.#base = (opts.base ?? NETFILE_BASE).replace(/\/+$/, "");
  }

  async #json(url: string): Promise<unknown> {
    const res = await this.#fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`NetFile answered ${res.status} for ${url}`);
    }
    return await res.json();
  }

  agencies(): Promise<NetFileAgency[]> {
    this.#agencies ??= this.#json(`${this.#base}/public/campaign/agencies?format=json`).then(
      (json) =>
        arrayIn(json).flatMap((a): NetFileAgency[] => {
          const r = normalizeRow(a);
          if (!r) return [];
          const id = get(r, "shortcut", "aid", "agencyshortcut");
          const name = get(r, "name", "agencyname");
          // The transaction search takes the agency's number, not its shortcut.
          const number = typeof r.id === "number" && Number.isInteger(r.id) ? r.id : undefined;
          return id && name ? [{ id, name, ...(number !== undefined ? { number } : {}) }] : [];
        }),
    ).catch((err) => {
      this.#agencies = null; // a failed read is tried again next time
      throw err;
    });
    return this.#agencies;
  }

  transactions(agency: string, year: number): Promise<ExportYear> {
    const key = `${agency}|${year}`;
    const hit = this.#years.get(key);
    if (hit && Date.now() - hit.at < EXPORT_CACHE_MS) return hit.got;
    const got = this.#readYear(agency, year).catch((err) => {
      this.#years.delete(key); // a failed read is tried again next time
      throw err;
    });
    this.#years.set(key, { at: Date.now(), got });
    return got;
  }

  /** The agency's number for the transaction search, from its shortcut. */
  async #numberOf(agency: string): Promise<number> {
    const n = (await this.agencies()).find((a) => a.id === agency)?.number;
    if (n === undefined) throw new Error(`NetFile lists no agency ${agency}`);
    return n;
  }

  /** Every committee the agency lists, so one that filed no rows is still found. */
  #agencyFilers(agency: string): Promise<Filer[]> {
    let got = this.#filers.get(agency);
    if (!got) {
      got = this.#json(
        `${this.#base}/public/campaign/list/filer?${new URLSearchParams({
          AID: agency,
          PageSize: String(NETFILE_PAGE_SIZE),
          CurrentPageIndex: "0",
          format: "json",
        })}`,
      ).then((json) => {
        const list = (json as Record<string, unknown> | null)?.filers;
        return (Array.isArray(list) ? list : []).flatMap((o): Filer[] => {
          const r = normalizeRow(o);
          const name = r ? get(r, "name") : "";
          const id = r ? get(r, "localagencyid", "fppcid") : "";
          return id && name ? [{ id, name, type: "", elections: [] }] : [];
        });
      }).catch((err) => {
        this.#filers.delete(agency);
        throw err;
      });
      this.#filers.set(agency, got);
    }
    return got;
  }

  /**
   * One year of the agency's transactions from NetFile's public transaction
   * search (the per-year CAL export it replaced is retired), current filings
   * only: an amended report's superseded rows are left out by NetFile itself.
   * Each row is put in the CAL field names the rest of this file reads.
   */
  async #readYear(agency: string, year: number): Promise<ExportYear> {
    const number = await this.#numberOf(agency);
    const url = `${this.#base}/public/campaign/search/transaction/query?${new URLSearchParams({
      Agency: String(number),
      DateStart: `${year}-01-01`,
      DateEnd: `${year}-12-31`,
      ShowSuperceded: "false",
      format: "json",
    })}`;
    const rows: ExportRow[] = [];
    const filers = new Map<string, Filer>();
    for (const f of await this.#agencyFilers(agency)) filers.set(f.id, f);
    for (let page = 0; page < NETFILE_MAX_PAGES; page++) {
      const json = await this.#json(
        `${url}&${new URLSearchParams({
          PageSize: String(NETFILE_PAGE_SIZE),
          CurrentPageIndex: String(page),
        })}`,
      );
      const batch = arrayIn(json).map(normalizeRow).filter((r): r is ExportRow => r !== null)
        .map(fromSearch);
      rows.push(...batch.filter(isContribution));
      for (const r of batch) if (!filers.has(filerId(r))) addFiler(filers, r);
      const pages = Number(
        (json as Record<string, unknown> | null)?.totalmatchingpages ??
          (json as Record<string, unknown> | null)?.totalMatchingPages,
      );
      const last = Number.isFinite(pages) && pages > 0
        ? page + 1 >= pages
        : batch.length < NETFILE_PAGE_SIZE;
      if (last) return { year, url, rows, filers: [...filers.values()], truncated: false };
    }
    return { year, url, rows, filers: [...filers.values()], truncated: true };
  }
}

/** The search's transaction types for contributions received, as CAL form codes. */
const SEARCH_TYPES: Record<string, string> = { "0": "A", "1": "C", "20": "F497P1" };

/**
 * A transaction search row in CAL field names. The search gives the
 * contributor as one name and no entity code: a contributor with its own FPPC
 * id is a committee (an organization); one with an occupation or employer,
 * which the forms ask only of individuals, is an individual; anyone else is
 * unknown, and src/finance.ts never matches an unknown.
 */
export function fromSearch(r: ExportRow): ExportRow {
  if (!("transactiontype" in r) || "formtype" in r) return r;
  const occ = get(r, "occupation"), emp = get(r, "employer");
  const entity = get(r, "transactionfppcid") ? "COM" : occ || emp ? "IND" : "";
  return {
    filerid: get(r, "filerlocalid", "filerfppcid"),
    filernaml: get(r, "filername"),
    formtype: SEARCH_TYPES[get(r, "transactiontype")] ?? `type ${get(r, "transactiontype")}`,
    entitycd: entity,
    trannaml: get(r, "name"),
    tranocc: occ,
    tranemp: emp,
    tranamt1: r.amount,
    trandate: get(r, "date"),
    filingid: get(r, "filingid"),
    tranid: get(r, "id"),
  };
}

// ---------------------------------------------------------------------------
// Which agency
// ---------------------------------------------------------------------------

/** "Oakland, CA" → ["Oakland", "CA"]; the state is what follows the last comma. */
function splitPlace(place: string): { jurisdiction: string; state: string } {
  const i = place.lastIndexOf(",");
  return i < 0
    ? { jurisdiction: place.trim(), state: "" }
    : { jurisdiction: place.slice(0, i).trim(), state: place.slice(i + 1).trim() };
}

/**
 * "Oakland, City of" and "City of Oakland" are one place; so are "County of
 * Alameda", "Alameda, County of", and "Alameda County". A trailing office
 * ("Ethics Commission", "City Clerk") is not part of the place.
 */
export function agencyKey(name: string): string {
  const k = nameKey(name)
    .replace(/ (ethics commission|city clerk|clerk|elections( office| department)?)$/, "");
  const flipped = k.match(/^(.+?) (city (and )?county|city|town|county) of$/);
  return jurisdictionKey(flipped ? `${flipped[2]} of ${flipped[1]}` : k);
}

/** "Oakland, City of" as a sentence names it: "City of Oakland". */
export function placeName(name: string): string {
  const m = name.trim().match(/^(.+), ((city (and )?county|city|town|county) of)$/i);
  return m ? `${m[2]} ${m[1]}` : name.trim();
}

/**
 * "Oakland=COAK; San Francisco=SFO": places whose NetFile agency is set by
 * hand, keyed as agencyKey reads a place. Malformed entries are skipped.
 */
export function parseAgencyMap(raw: string | undefined): Map<string, NetFileAgency> {
  const map = new Map<string, NetFileAgency>();
  for (const part of (raw ?? "").split(/[;\n]/)) {
    const [name, id] = part.split("=").map((s) => s.trim());
    if (name && id && /^[A-Za-z0-9]+$/.test(id)) map.set(agencyKey(name), { id, name });
  }
  return map;
}

/**
 * The one NetFile agency for a place in California, or null: elsewhere,
 * none matching, or more than one (never a guess between them).
 */
export async function agencyFor(
  place: string,
  source: NetFileSource,
  overrides: ReadonlyMap<string, NetFileAgency> = new Map(),
): Promise<NetFileAgency | null> {
  const { jurisdiction, state } = splitPlace(place);
  if (!/^(ca|california)$/i.test(state) || !jurisdiction) return null;
  const key = agencyKey(jurisdiction);
  const set = overrides.get(key);
  if (set) return set;
  const found = (await source.agencies()).filter((a) => agencyKey(a.name) === key);
  return new Set(found.map((a) => a.id)).size === 1
    ? { id: found[0].id, name: placeName(found[0].name) }
    : null;
}

// ---------------------------------------------------------------------------
// Which rows, and whose
// ---------------------------------------------------------------------------

/** Contributions received: Form 460 Schedules A and C, and late ones on Form 497. */
const FORMS: Record<string, string> = {
  A: "Form 460, Schedule A",
  C: "Form 460, Schedule C",
  F497P1: "Form 497, Part 1",
};

const formOf = (r: ExportRow) => get(r, "formtype", "form").toUpperCase().replace(/^SCHEDULE /, "");

function isContribution(r: ExportRow): boolean {
  return formOf(r) in FORMS;
}

export interface Filer {
  id: string;
  name: string;
  type: string;
  /** Years of the election dates its reports state; empty when none is stated. */
  elections?: number[];
}

const filerId = (r: ExportRow) =>
  get(r, "filerid", "filerlocalid", "filerfppcid", "filerstateid") ||
  nameKey(get(r, "filernaml", "filername"));

/** Adds a row's committee, gathering the election years its reports state. */
function addFiler(filers: Map<string, Filer>, r: ExportRow): void {
  const id = filerId(r);
  const f = filers.get(id) ?? {
    id,
    name: get(r, "filernaml", "filername"),
    type: get(r, "committeetype", "cmtetype").toUpperCase(),
    elections: [],
  };
  const y = Number(get(r, "electdate", "electiondate").slice(0, 4));
  if (Number.isInteger(y) && y > 1900 && !f.elections!.includes(y)) f.elections!.push(y);
  filers.set(id, f);
}

/**
 * Words naming an office. A committee's name that holds some must share one
 * with the race's office, so a same-named person running for another office
 * in the same place is never matched.
 */
const OFFICE_WORDS = [
  "mayor",
  "council",
  "councilmember",
  "supervisor",
  "board",
  "school",
  "education",
  "trustee",
  "auditor",
  "attorney",
  "treasurer",
  "clerk",
  "assessor",
  "sheriff",
  "controller",
  "judge",
  "assembly",
  "senate",
  "college",
  "water",
  "district",
];

function officeFits(filerName: string, contest: string | undefined): boolean {
  if (!contest) return true;
  const said = OFFICE_WORDS.filter((w) => filerName.includes(` ${w} `));
  if (!said.length) return true;
  const office = words(contest);
  // "District" alone says too little: it must come with another word the office shares.
  const telling = said.filter((w) => w !== "district");
  return (telling.length ? telling : said).some((w) =>
    office.includes(` ${w} `) || office.includes(` ${w}s `)
  );
}

/** The committee's name holds an office word that the race's office has too. */
function namesOffice(filerName: string, contest: string | undefined): boolean {
  if (!contest) return false;
  const office = words(contest);
  return OFFICE_WORDS.some((w) =>
    w !== "district" && filerName.includes(` ${w} `) &&
    (office.includes(` ${w} `) || office.includes(` ${w}s `))
  );
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "md", "phd", "esq"]);
/** Never a candidate's own committee, whatever names it holds. */
const AGAINST = /\b(recall|oppose|opposing|against|stop|defeat|no on)\b/;
const SUPPORT = /\b(yes|for|support|supporting|supports)\b/;
const OPPOSE = /\b(no|against|oppose|opposing|opposes|stop|defeat)\b/;

/** A committee named for another year's election is that election's. */
function otherYear(name: string, year: number): boolean {
  return (name.match(/\b(19|20)\d\d\b/g) ?? []).some((y) => Number(y) !== year);
}

const words = (s: string) => ` ${nameKey(s)} `;

/** "Proposition 50" and "Prop. 50" are one label. */
const labelWords = (s: string) => words(s).replace(/ proposition /g, " prop ");

/** Whether a committee's name ties it to this subject, by the rules above. */
export function filerMatches(
  f: Filer,
  s: FinanceSubject,
  year: number,
  contest?: string,
): boolean {
  if (!f.name || otherYear(f.name, year)) return false;
  // A committee whose reports state another election is that election's (measure letters repeat).
  if (f.elections?.length && !f.elections.includes(year)) return false;
  const name = words(f.name);
  if (s.role === "candidate") {
    if (f.type && f.type !== "CTL") return false;
    if (AGAINST.test(name)) return false;
    if (!officeFits(name, contest)) return false;
    const parts = nameKey(s.name).split(" ").filter((w) => w.length > 1 && !SUFFIXES.has(w));
    if (parts.length < 2 || !name.includes(` ${parts.at(-1)} `)) return false;
    if (name.includes(` ${parts[0]} `)) return true;
    // Surname only ("Armendarez for City Treasurer 2026"): only when the name also states
    // this election's year and this race's office, so it can't be a namesake's elsewhere.
    return name.includes(` ${year} `) && namesOffice(name, contest);
  }
  const label = labelWords(s.name).trim();
  const named = labelWords(f.name);
  if (!label || !named.includes(` ${label} `)) return false;
  // "Yes on Measure A" or "No on Measure A" says the side outright, whatever else the name holds.
  const yesOn = named.includes(` yes on ${label} `), noOn = named.includes(` no on ${label} `);
  if (yesOn !== noOn) return s.role === "support" ? yesOn : noOn;
  const yes = SUPPORT.test(name), no = OPPOSE.test(name);
  return s.role === "support" ? yes && !no : no && !yes;
}

/** "Jane Q Smith Jr" for a person, the name for anyone else: the record's own parts, in order. */
function contributorName(r: ExportRow): string {
  const last = get(r, "trannaml", "contributorlastname", "contributorname");
  const first = get(r, "trannamf", "contributorfirstname");
  return [first, last, get(r, "trannams")].filter(Boolean).join(" ");
}

const ENTITY: Record<string, string> = {
  IND: "individual",
  COM: "organization",
  OTH: "organization",
  PTY: "organization",
  SCC: "organization",
};

const plainDate = (d: string) => d.replace(/T00:00:00(\.0+)?(Z|[+-]\d\d:\d\d)?$/, "");

function amountOf(r: ExportRow): string {
  return get(r, "tranamt1", "amount", "tranamount");
}

export function filingImage(base: string, id: string): string | undefined {
  return /^\d+$/.test(id) ? `${base.replace(/\/+$/, "")}/public/image/${id}` : undefined;
}

function toRaw(r: ExportRow, y: ExportYear, agency: NetFileAgency, base: string): RawContribution {
  const form = FORMS[formOf(r)];
  const filingId = get(r, "filingid", "netfilefilingid", "filingnumber");
  const from = plainDate(get(r, "fromdate")), thru = plainDate(get(r, "thrudate"));
  const image = filingImage(base, filingId);
  return {
    filer: get(r, "filernaml", "filername"),
    contributor: contributorName(r),
    contributor_type: ENTITY[get(r, "entitycd", "entitycode").toUpperCase()] ?? "unknown",
    occupation: get(r, "tranocc", "occupation"),
    employer: get(r, "tranemp", "employer"),
    amount: amountOf(r),
    date: plainDate(get(r, "trandate", "transactiondate")),
    filing_period: from && thru ? `${from} to ${thru}` : "",
    filing: filingId ? `${form}, filing ${filingId}` : form,
    source_name: `${agency.name}, NetFile export, ${y.year}`,
    source_url: y.url,
    ...(image ? { filing_url: image } : {}),
  };
}

/**
 * A late contribution (Form 497) is reported again on the next Form 460: the
 * same filer, contributor, amount, and date there means one gift, kept once,
 * as the 460 has it.
 */
/**
 * An amended report lists its transactions again under its own filing: one
 * transaction (the same committee and transaction id) is kept once, from the
 * latest filing.
 */
function latestOnly(rows: readonly ExportRow[]): ExportRow[] {
  const latest = new Map<string, ExportRow>();
  const kept: ExportRow[] = [];
  const filing = (r: ExportRow) => Number(get(r, "filingid", "netfilefilingid")) || 0;
  for (const r of rows) {
    const tran = get(r, "tranid", "transactionid");
    if (!tran) {
      kept.push(r);
      continue;
    }
    const k = JSON.stringify([filerId(r), formOf(r), tran]);
    const had = latest.get(k);
    if (!had || filing(r) > filing(had)) latest.set(k, r);
  }
  return [...kept, ...latest.values()];
}

function withoutRepeats(rows: readonly RawContribution[]): RawContribution[] {
  const key = (c: RawContribution) =>
    JSON.stringify([c.filer, nameKey(c.contributor), c.amount, c.date]);
  const on460 = new Set(rows.filter((c) => c.filing.startsWith("Form 460")).map(key));
  return rows.filter((c) => c.filing.startsWith("Form 460") || !on460.has(key(c)));
}

const byAmount = (a: RawContribution, b: RawContribution) =>
  (Number(b.amount.replace(/[^\d.-]/g, "")) || 0) - (Number(a.amount.replace(/[^\d.-]/g, "")) || 0);

// ---------------------------------------------------------------------------
// The researcher
// ---------------------------------------------------------------------------

export interface NetFileResearcherOptions {
  source: NetFileSource;
  /** The model lookup, for places not on NetFile. Without one, those calls fail. */
  fallback?: FinanceResearcher;
  /** Places whose agency is set by hand (parseAgencyMap). */
  agencies?: ReadonlyMap<string, NetFileAgency>;
  /** For filing image links; the client's base. */
  base?: string;
  log?: (msg: string) => void;
}

/**
 * The place isn't NetFile's, or none of its committees fit a subject: the
 * fallback runs. With a message, the page says why (a portal gap).
 */
class NotHere extends Error {}

export class NetFileResearcher implements FinanceResearcher {
  readonly #o: NetFileResearcherOptions;

  constructor(opts: NetFileResearcherOptions) {
    this.#o = opts;
  }

  /**
   * The export where the place is on NetFile; else, or when it can't be
   * read, the fallback for every subject alike, never a mix of the two.
   */
  async findContributions(request: FinanceRequest): Promise<RawFinanceResult> {
    let why: string;
    try {
      return await this.#read(request);
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
      if (!(err instanceof NotHere)) why = `NetFile couldn't be read: ${why}`;
      if (why) this.#o.log?.(`[netfile] ${why}`);
      if (!this.#o.fallback) throw why ? err : new Error(`No NetFile agency for ${request.place}.`);
    }
    const r = await this.#o.fallback.findContributions(request);
    if (!why) return r;
    const gap: RawPortalGap = {
      portal: "NetFile",
      url: "",
      problem: "other",
      note: `${why} The filings were looked up by the model instead.`,
    };
    return { ...r, portal_gaps: [gap, ...r.portal_gaps] };
  }

  async #read(request: FinanceRequest): Promise<RawFinanceResult> {
    const { source } = this.#o;
    const agency = await agencyFor(request.place, source, this.#o.agencies);
    if (!agency) throw new NotHere("");
    const year = Number(request.electionDate.slice(0, 4));
    if (!Number.isInteger(year)) throw new NotHere("");
    // Campaigns raise money the year before an election too.
    const years: ExportYear[] = [], gaps: RawPortalGap[] = [];
    for (const y of [year - 1, year]) {
      try {
        const got = await source.transactions(agency.id, y);
        years.push(got);
        if (got.truncated) {
          gaps.push({
            portal: `${agency.name} NetFile export, ${y}`,
            url: got.url,
            problem: "other",
            note:
              `The export is longer than this run reads (${NETFILE_MAX_PAGES} pages of ${NETFILE_PAGE_SIZE} rows); later rows weren't read.`,
          });
        }
      } catch (err) {
        gaps.push({
          portal: `${agency.name} NetFile export, ${y}`,
          url: "",
          problem: "other",
          note: `It couldn't be read: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    if (!years.length) {
      throw new NotHere(
        `${agency.name}'s NetFile export couldn't be read for ${year - 1} or ${year}.`,
      );
    }

    const base = this.#o.base ?? NETFILE_BASE;
    const filers = new Map<string, Filer>();
    for (const y of years) {
      if (y.filers) {
        for (const f of y.filers) {
          const had = filers.get(f.id);
          filers.set(f.id, {
            ...f,
            elections: [...new Set([...had?.elections ?? [], ...f.elections ?? []])],
          });
        }
      } else for (const r of y.rows) if (!filers.has(filerId(r))) addFiler(filers, r);
    }
    // A committee that two subjects' names both fit is neither's.
    const owners = new Map<string, FinanceSubject[]>();
    for (const f of filers.values()) {
      owners.set(f.id, request.subjects.filter((s) => filerMatches(f, s, year, request.contest)));
    }
    const mine = (s: FinanceSubject) =>
      [...filers.values()].filter((f) =>
        owners.get(f.id)!.length === 1 && owners.get(f.id)![0] === s
      );
    const shared = (s: FinanceSubject) =>
      [...filers.values()].filter((f) =>
        owners.get(f.id)!.length > 1 && owners.get(f.id)!.includes(s)
      );
    if (!request.subjects.some((s) => mine(s).length)) {
      throw new NotHere(
        `No committee in ${agency.name}'s NetFile filings for ${
          year - 1
        }–${year} matched a candidate or side by name.`,
      );
    }

    const searched = years.map((y) => `${agency.name} NetFile export, ${y.year}`);
    // Only the years actually read: a failed one is a portal gap, not searched.
    const span = years.map((y) => y.year).join("–");
    const subjects: RawFinanceSubject[] = request.subjects.map((s) => {
      const committees = mine(s);
      const ids = new Set(committees.map((f) => f.id));
      const rows = withoutRepeats(
        years.flatMap((y) =>
          latestOnly(y.rows.filter((r) => ids.has(filerId(r)))).map((r) =>
            toRaw(r, y, agency, base)
          )
        ),
      ).sort(byAmount);
      const both = shared(s);
      const gap_note = !committees.length
        ? [
          `No committee in ${agency.name}'s NetFile filings for ${span} has a name this check ties to ${
            s.role === "candidate"
              ? `${s.name} (it needs their first and last name, or their surname with this race's office and ${year}, and no other office named)`
              : `the ${
                s.role === "support" ? "yes" : "no"
              } side of ${s.name} (it needs the label and words of that side only)`
          }.`,
          both.length
            ? `Fits more than one candidate or side, so kept for neither: ${
              both.map((f) => f.name).join("; ")
            }.`
            : "",
          "That is not evidence there is none: the committee may file elsewhere or under another name.",
        ].filter(Boolean).join(" ")
        : rows.length
        ? ""
        : `The NetFile filings of ${
          committees.map((f) => f.name).join("; ")
        } for ${span} list no itemized contributions received.`;
      return {
        id: s.id,
        committees: committees.map((f) => f.name),
        searched,
        gap_note,
        not_listed: "",
        totals: [],
        contributions: rows,
      };
    });
    this.#o.log?.(
      `[netfile] ${agency.id} ${years.map((y) => `${y.year}: ${y.rows.length} rows`).join(", ")}`,
    );
    return {
      subjects,
      portal_gaps: gaps,
      retrieved_urls: years.map((y) => y.url),
      model: "netfile",
      source: {
        kind: "netfile",
        agency: agency.id,
        agency_name: agency.name,
        years: years.map((y) => y.year),
      },
      per_subject: MAX_EXPORT_PER_SUBJECT,
    };
  }
}
