/**
 * Turns unvalidated research into a dossier that obeys the invariants.
 *
 * - Every section in the template is present, for every candidate, in order.
 * - A section with no facts always carries a gap note.
 * - A fact is shown as verified only if its URL is one the research session
 *   actually retrieved. Everything else goes to `unverified`, never dropped
 *   silently and never mixed in.
 * - Each verified fact's quote is checked against the page the session
 *   opened, and the fact gets a level (quoted, not_found, seen) and, when the
 *   page doesn't name its subject, a flag. Neither ever drops a fact.
 * - Unknown evidence types collapse to "unsourced", the least trusted tag.
 */

import {
  MAX_PRIORITIES_PER_LIST,
  MAX_PRIORITY_LENGTH,
  MEASURE_SECTION_IDS,
  MEASURE_SECTIONS,
  priorityId,
  SECTION_IDS,
  SECTIONS,
} from "./template.ts";
import { nameKey } from "./knowledge.ts";
import {
  type BallotCandidate,
  type BallotListing,
  type BallotMeasure,
  type BallotReading,
  type CandidateDossier,
  EVIDENCE_TYPES,
  type EvidenceType,
  type Fact,
  type FactCheck,
  type MeasureDossier,
  type MeasureQuery,
  type MeasureSectionId,
  type OpenedPage,
  type PriorityResult,
  type RawCandidateResearch,
  type RawFact,
  type RawMeasureResearch,
  type RawSection,
  type RawStance,
  type ResearchEffort,
  type SectionId,
  type SectionResult,
  type Stance,
  STANCES,
  type StanceStrength,
  type VoteMeanings,
} from "./types.ts";

/** Phase 0's permanent blind spots. Shown on every page, every run. */
export const STANDING_GAPS: readonly string[] = [
  "Phase 0 researches with general web search, plus one capped lookup of campaign finance filings per run. It does not read council minutes or budget documents directly, and filing portals behind a login or JavaScript can't be read, so records that search engines don't index are likely missing.",
  "Paywalled local news is usually not readable, so coverage from subscription outlets may be absent or represented only by headlines.",
  "Social media is not searched: Facebook community groups, Nextdoor, Instagram, and TikTok, where much local political discussion happens, are a blind spot.",
  "PDF records (agendas, minutes, budgets, filings) are only included when search surfaced them and they could be fetched.",
  "Absence of a finding is not evidence of absence. An empty section means this run found nothing, not that nothing exists.",
];

/** Normalize a URL for provenance matching: host case, fragment, trailing slash, tracking params. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
  }
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  const search = u.searchParams.toString();
  // http and https are treated as the same page.
  return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${search ? `?${search}` : ""}`;
}

function toEvidenceType(v: string): EvidenceType {
  return (EVIDENCE_TYPES as readonly string[]).includes(v) ? v as EvidenceType : "unsourced";
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

/** An adapter's search and fetch counts, kept only when both are whole, non-negative numbers. */
function effortOf(e: unknown): { effort?: ResearchEffort } {
  const o = e as Partial<ResearchEffort> | null | undefined;
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
  return o && ok(o.searches) && ok(o.fetches)
    ? { effort: { searches: o.searches, fetches: o.fetches } }
    : {};
}

/** The searches and fetches a failed research call made, when its error carries them. */
export function failureEffort(err: unknown): ResearchEffort | undefined {
  return effortOf((err as { effort?: unknown } | null)?.effort).effort;
}

function cleanOrNull(s: unknown): string | null {
  const v = clean(s);
  return v ? v : null;
}

/** An ISO day, month, or year: the forms dates sort in as text. */
export const ISO_DATE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;

/**
 * The event date as the research gave it, when it is an ISO day, month, or
 * year, and not after today; anything else can't be ordered as something
 * that happened, so it reads as unknown (null). A
 * fact built now always has the field, so the page can tell a run with
 * event dates from one saved before them.
 */
function eventDate(s: unknown): string | null {
  const v = clean(s);
  if (!ISO_DATE.test(v)) return null;
  // A date after today is something scheduled, not something that happened.
  return v > new Date().toISOString().slice(0, v.length) ? null : v;
}

/** Longest quote kept. The prompt asks for under 300 characters; a longer one is not kept, never cut. */
export const MAX_QUOTE_LENGTH = 600;

function toFact(raw: RawFact): Fact | null {
  const statement = clean(raw.statement);
  const source_url = clean(raw.source_url);
  if (!statement || normalizeUrl(source_url) === null) return null;
  const quote = clean(raw.quote);
  return {
    statement,
    source_name: clean(raw.source_name) || "source name not given",
    source_url,
    author: cleanOrNull(raw.author),
    published: cleanOrNull(raw.published),
    event_date: eventDate(raw.event_date),
    evidence_type: toEvidenceType(clean(raw.evidence_type)),
    ...(quote && quote.length <= MAX_QUOTE_LENGTH ? { quote } : {}),
  };
}

/**
 * Text as the quote check compares it: lowercase, with every run of
 * punctuation, quote marks, dashes, and whitespace made one space, so curly
 * quotes, a markdown link, or a line break don't hide a match. Accents are
 * dropped as `nameKey` (src/knowledge.ts) drops them, so "García" and
 * "Garcia" compare equal. Markdown link targets (and their titles) are
 * dropped, since a fetched page's text can carry them.
 */
export function plainText(s: string): string {
  return ` ${
    s.normalize("NFKD").replace(/\p{M}/gu, "")
      .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, " ").toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  } `;
}

/** Fewer words than this can't show a page backs a statement; such a quote isn't checked. */
export const MIN_QUOTE_WORDS = 5;

/**
 * Whether a quote is on a page: each piece, if the model joined pieces with
 * an ellipsis anyway, appears whole-word and in order. null when the quote
 * is too short to say.
 */
export function quoteOnPage(quote: string, page: string): boolean | null {
  return quoteIn(quote, plainText(page));
}

/** quoteOnPage, against a page's text already made plain. */
function quoteIn(quote: string, hay: string): boolean | null {
  const parts = quote.split(/\.\.\.|\u2026/).map(plainText).filter((p) => p.trim());
  // The minimum is for the whole quote: a short piece still has to be on the page,
  // so a made-up ending after an ellipsis reads as not found.
  const words = parts.reduce((n, p) => n + p.trim().split(" ").length, 0);
  if (words < MIN_QUOTE_WORDS) return null;
  let at = 0;
  for (const p of parts) {
    const i = hay.indexOf(p, at);
    if (i < 0) return false;
    // The next piece may start at this one's closing space.
    at = i + p.length - 1;
  }
  return true;
}

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "phd", "md", "esq"]);

/** A candidate's surname as written, for the name check: the last word that isn't a suffix. */
export function surname(name: string): string {
  const words = name.split(/[\s,]+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  while (words.length > 1 && NAME_SUFFIXES.has(plainText(words.at(-1)!).trim())) words.pop();
  return words.at(-1) ?? "";
}

/**
 * Who the facts are about, for the name check: the name shown in the flag,
 * and every way a page may write it (a measure's "Prop. 50", its official title).
 */
export interface Subject {
  shown: string;
  terms: string[];
}

export function candidateSubject(c: BallotCandidate): Subject {
  const s = surname(c.name);
  return { shown: s, terms: s ? [s] : [] };
}

export function measureSubject(label: string, officialTitle: string | null): Subject {
  const terms = [label];
  const prop = label.trim().match(/^prop(?:osition)?\.?\s*(\S+)$/i);
  if (prop) terms.push(`Prop ${prop[1]}`, `Proposition ${prop[1]}`);
  if (officialTitle) terms.push(officialTitle);
  return { shown: label.trim(), terms: terms.filter((t) => plainText(t).trim()) };
}

/** What the session retrieved: every URL, and the text of the pages it opened. */
interface Retrieved {
  urls: ReadonlySet<string>;
  /** Normalized URL to the page's plainText; null for a page opened but not readable (a PDF). */
  opened: ReadonlyMap<string, string | null>;
  subject: Subject;
  /** Per opened page, whether it names the subject: computed once, not per fact. */
  named: Map<string, boolean>;
}

function retrieved(
  urls: readonly string[],
  pages: readonly OpenedPage[] | undefined,
  subject: Subject,
): Retrieved {
  const opened = new Map<string, string | null>();
  for (const p of pages ?? []) {
    const key = normalizeUrl(p.url);
    // A page fetched twice keeps the copy whose text can be read.
    if (key && (opened.get(key) ?? null) === null) {
      opened.set(key, p.text === null ? null : plainText(p.text));
    }
  }
  return { urls: retrievedSet(urls), opened, subject, named: new Map() };
}

/** The quote and name check for a fact whose page the session retrieved. */
function checkQuote(f: Fact, key: string, r: Retrieved): FactCheck {
  const opened = r.opened.has(key);
  const hay = r.opened.get(key) ?? null;
  if (hay === null) return { level: "seen", opened, read: false };
  const found = f.quote ? quoteIn(f.quote, hay) : null;
  let named = r.named.get(key);
  if (named === undefined) {
    named = !r.subject.terms.length ||
      r.subject.terms.some((t) => hay.includes(plainText(t)));
    r.named.set(key, named);
  }
  return {
    level: found === null ? "seen" : found ? "quoted" : "not_found",
    opened,
    read: true,
    ...(named ? {} : { missing_name: r.subject.shown }),
  };
}

function emptySection(gap: string): SectionResult {
  return { facts: [], searched: [], gap_note: gap };
}

export const NOTHING_FOUND = "This run found nothing it could source for this section.";

/**
 * The provenance check for one fact: it comes back, with its quote check,
 * only if the session retrieved its page; otherwise it goes to `unverified`.
 * Invalid facts are dropped.
 */
function checkFact(
  rf: RawFact,
  retrieved: Retrieved,
  unverified: Fact[],
): Fact | null {
  const f = toFact(rf);
  if (!f) return null;
  const key = normalizeUrl(f.source_url)!;
  if (retrieved.urls.has(key)) return { ...f, check: checkQuote(f, key, retrieved) };
  unverified.push(f);
  return null;
}

/**
 * Validates one section and runs the provenance check: facts citing a page
 * the session never retrieved are moved to `unverified`.
 */
function assembleSection(
  rs: RawSection | undefined,
  retrieved: Retrieved,
  unverified: Fact[],
  emptyNote: string,
): SectionResult {
  const facts: Fact[] = [];
  for (const rf of rs?.facts ?? []) {
    const f = checkFact(rf, retrieved, unverified);
    if (f) facts.push(f);
  }
  const searched = (rs?.searched ?? []).map(clean).filter(Boolean);
  const gap_note = cleanOrNull(rs?.gap_note) ?? (facts.length ? null : emptyNote);
  return { facts, searched, gap_note };
}

function retrievedSet(urls: readonly string[]): Set<string> {
  return new Set(urls.map(normalizeUrl).filter((u): u is string => u !== null));
}

/** What a stance on one issue rests on, counted the same way for everyone. */
export interface StanceSupport {
  /** Verified facts on the issue, unsourced ones aside, merged sources included. */
  facts: number;
  /**
   * Of those, the ones whose quote was found on the page they cite, a page
   * that names the subject (`missing_name` unset).
   */
  quoted: number;
  /** Distinct outlets among the quoted ones, by name and by page alike. */
  outlets: number;
  /** Quoted primary records. */
  primary: number;
}

/**
 * Counts the facts under one issue toward the stance threshold. Only facts
 * at the `quoted` level count toward `quoted`, `outlets`, and `primary`; a
 * merged fact's other sources count as their own (src/merge.ts keeps them at
 * one level, one per outlet), so the count reads the same before and after
 * the merge step.
 */
export function stanceSupport(r: SectionResult): StanceSupport {
  const all = r.facts.flatMap((f) => [f, ...(f.also ?? [])])
    .filter((f) => f.evidence_type !== "unsourced");
  const quoted = all.filter((f) => f.check?.level === "quoted" && !f.check.missing_name);
  // One page cited under two names, or two names for one outlet's page, is still one.
  const names = new Set(quoted.map((f) => nameKey(f.source_name))).size;
  const pages = new Set(quoted.map((f) => normalizeUrl(f.source_url) ?? f.source_url)).size;
  return {
    facts: all.length,
    quoted: quoted.length,
    outlets: Math.min(names, pages),
    primary: quoted.filter((f) => f.evidence_type === "primary_record").length,
  };
}

/** The stances that mark the voter's view, and so carry a strength. */
export function marksView(st: Stance | undefined): boolean {
  return st === "conflicts" || st === "aligns" || st === "mixed";
}

/** A stance stands in full on one quoted primary record, or quoted facts from two outlets. */
export function strengthOf(s: StanceSupport): StanceStrength {
  return s.primary >= 1 || s.outlets >= 2 ? "full" : "thin";
}

/**
 * The voter's issues, each as its own section, in their order. A stance
 * other than "no_position" stands only on verified facts: with none, it is
 * "unclear", whatever the researcher said. "conflicts", "aligns", and
 * "mixed" are full only past the threshold (`strengthOf`); below it they
 * are kept as the researcher's call, marked thin.
 */
function assemblePriorities(
  issues: readonly string[],
  raw: {
    sections: Record<string, RawSection | undefined>;
    stances?: Record<string, RawStance | undefined>;
  },
  retrieved: Retrieved,
  unverified: Fact[],
): PriorityResult[] {
  return issues.map((issue, i) => {
    const id = priorityId(i);
    const result = assembleSection(raw.sections[id], retrieved, unverified, NOTHING_FOUND);
    const rs = raw.stances?.[id];
    let stance: Stance = rs && (STANCES as readonly string[]).includes(rs.stance)
      ? rs.stance as Stance
      : "unclear";
    let stance_basis = cleanOrNull(rs?.basis);
    const usable = result.facts.filter((f) => f.evidence_type !== "unsourced");
    if (stance !== "no_position" && stance !== "unclear") {
      if (usable.length === 0) {
        stance = "unclear";
        stance_basis = "No verified source in this run supports a stance on this.";
      } else if (usable.every((f) => f.evidence_type === "opinion")) {
        // Candidates' own statements count, but say so: no record or reporting backs it.
        stance_basis = `${
          stance_basis ? `${stance_basis} ` : ""
        }(Rests only on statements, endorsements, or advocacy, not records or reporting.)`;
      }
    }
    const strength = marksView(stance)
      ? { stance_strength: strengthOf(stanceSupport(result)) }
      : {};
    return { issue, result, stance, stance_basis, ...strength };
  });
}

/** Same placeholder for every issue, for failed and pending results. */
function placeholderPriorities(issues: readonly string[], note: string): PriorityResult[] {
  return issues.map((issue) => ({ issue, result: emptySection(note) }));
}

export function assembleCandidate(
  candidate: BallotCandidate,
  raw: RawCandidateResearch,
  priorities: readonly string[] = [],
): CandidateDossier {
  const seen = retrieved(raw.retrieved_urls, raw.opened_pages, candidateSubject(candidate));
  const unverified: Fact[] = [];
  const sections = {} as Record<SectionId, SectionResult>;

  for (const spec of SECTIONS) {
    sections[spec.id] = assembleSection(
      raw.sections[spec.id],
      seen,
      unverified,
      "incumbentOnly" in spec && spec.incumbentOnly && !candidate.incumbent
        ? "Not the incumbent in this office, so there is no record in it to report."
        : NOTHING_FOUND,
    );
  }

  return {
    candidate,
    status: "ok",
    sections,
    unverified,
    identity_note: cleanOrNull(raw.identity_note),
    priorities: assemblePriorities(priorities, raw, seen, unverified),
    gaps: raw.gaps.map(clean).filter(Boolean),
    model: raw.model,
    ...effortOf(raw.effort),
    error: null,
  };
}

/** A failed candidate still gets the full template, so the page never silently drops anyone. */
export function failedCandidate(
  candidate: BallotCandidate,
  error: string,
  priorities: readonly string[] = [],
  effort?: ResearchEffort,
): CandidateDossier {
  const note = "Research for this candidate failed in this run; nothing was checked.";
  const sections = {} as Record<SectionId, SectionResult>;
  for (const id of SECTION_IDS) sections[id] = emptySection(note);
  return {
    candidate,
    status: "failed",
    sections,
    unverified: [],
    identity_note: null,
    priorities: placeholderPriorities(priorities, note),
    gaps: [`Research failed: ${error}`],
    model: null,
    ...effortOf(effort),
    error,
  };
}

/** Placeholder for a candidate still being researched; replaced when their research finishes. */
export function pendingCandidate(
  candidate: BallotCandidate,
  priorities: readonly string[] = [],
): CandidateDossier {
  const sections = {} as Record<SectionId, SectionResult>;
  for (const id of SECTION_IDS) sections[id] = emptySection("Still researching.");
  return {
    candidate,
    status: "pending",
    sections,
    unverified: [],
    identity_note: null,
    priorities: placeholderPriorities(priorities, "Still researching."),
    gaps: [],
    model: null,
    error: null,
  };
}

/** Sections with at least one verified fact. Drives the overview's coverage line. */
export function coveredSections(d: CandidateDossier): number {
  // Runs saved before a section existed don't have it; they count it as not covered.
  return SECTION_IDS.filter((id) => (d.sections[id]?.facts.length ?? 0) > 0).length;
}

/**
 * The yes and no meanings get the same provenance check as any fact: one
 * citing a page the session never retrieved goes to `unverified`.
 */
function assembleVoteMeans(
  raw: RawMeasureResearch["vote_means"],
  retrieved: Retrieved,
  unverified: Fact[],
): VoteMeanings {
  // What a vote would do is not an event, so it never carries an event date.
  const one = (rf: RawFact | undefined) =>
    rf ? checkFact({ ...rf, event_date: null }, retrieved, unverified) : null;
  return { yes: one(raw?.yes), no: one(raw?.no) };
}

export function assembleMeasure(
  query: MeasureQuery,
  raw: RawMeasureResearch,
  priorities: readonly string[],
  now: Date,
): MeasureDossier {
  const official_title = cleanOrNull(raw.official_title);
  const seen = retrieved(
    raw.retrieved_urls,
    raw.opened_pages,
    measureSubject(query.label, official_title),
  );
  const unverified: Fact[] = [];
  const sections = {} as Record<MeasureSectionId, SectionResult>;
  for (const spec of MEASURE_SECTIONS) {
    sections[spec.id] = assembleSection(raw.sections[spec.id], seen, unverified, NOTHING_FOUND);
  }
  return {
    query,
    status: "ok",
    official_title,
    vote_means: assembleVoteMeans(raw.vote_means, seen, unverified),
    sections,
    priorities: assemblePriorities(priorities, raw, seen, unverified),
    priority_issues: [...priorities],
    unverified,
    identity_note: cleanOrNull(raw.identity_note),
    gaps: raw.gaps.map(clean).filter(Boolean),
    standing_gaps: [...STANDING_GAPS],
    model: raw.model,
    ...effortOf(raw.effort),
    error: null,
    generated_at: now.toISOString(),
  };
}

/** A measure whose research failed or hasn't finished still shows the whole template. */
export function placeholderMeasure(
  query: MeasureQuery,
  priorities: readonly string[],
  now: Date,
  error: string | null,
  effort?: ResearchEffort,
): MeasureDossier {
  const note = error
    ? "Research for this measure failed in this run; nothing was checked."
    : "Still researching.";
  const sections = {} as Record<MeasureSectionId, SectionResult>;
  for (const id of MEASURE_SECTION_IDS) sections[id] = emptySection(note);
  return {
    query,
    status: error ? "failed" : "pending",
    official_title: null,
    sections,
    priorities: placeholderPriorities(priorities, note),
    priority_issues: [...priorities],
    unverified: [],
    identity_note: null,
    gaps: error ? [`Research failed: ${error}`] : [],
    standing_gaps: [...STANDING_GAPS],
    model: null,
    ...effortOf(effort),
    error,
    generated_at: now.toISOString(),
  };
}

/**
 * The yes/no items on a reading. Readings saved before measures were
 * researched hold bare strings; those come back as measures with the string
 * as their label, since there is no telling them apart from retention reliably.
 */
export function measuresOf(r: BallotReading): BallotMeasure[] {
  return r.measures.map((m) =>
    typeof m === "string"
      ? { kind: "measure", label: m, jurisdiction: "", question: "", person: "" }
      : m
  );
}

/**
 * Election invariant 2: incumbency asymmetry is disclosed, not hidden. Returns
 * the note to show on the race overview, or null when nobody is an incumbent.
 */
export function incumbencyNote(listing: BallotListing): string | null {
  if (listing.contest_kind === "retention") {
    const names = listing.candidates.map((c) => c.name).join(" and ");
    return `This is a yes/no retention question: voters decide whether ${
      names || "the judge"
    } keeps the seat, so there is no opponent to compare with. Judicial conduct rules limit what judges can say about issues, so a short platform section is expected.`;
  }
  const incumbents = listing.candidates.filter((c) => c.incumbent).map((c) => c.name);
  if (incumbents.length === 0) return null;
  return `${incumbents.join(" and ")} ${
    incumbents.length === 1 ? "holds" : "hold"
  } this office now, so there is a public record in it to research. Challengers usually have far less. A shorter dossier is not a cleaner one, and a longer one is not a worse one.`;
}

/**
 * The optional "what matters most to you" list: one issue per line (or
 * semicolon). Each becomes the same extra question for every candidate.
 */
export function parsePriorities(text: string): { ok: true; issues: string[] } | {
  ok: false;
  error: string;
} {
  const issues = text.split(/[\n;]/)
    // deno-lint-ignore no-control-regex
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (issues.length > MAX_PRIORITIES_PER_LIST) {
    return {
      ok: false,
      error: `Name up to ${MAX_PRIORITIES_PER_LIST} issues that matter most to you in each list.`,
    };
  }
  if (issues.some((s) => s.length > MAX_PRIORITY_LENGTH)) {
    return {
      ok: false,
      error: `Keep each issue to ${MAX_PRIORITY_LENGTH} characters, like "housing costs".`,
    };
  }
  const seen = new Set<string>();
  return {
    ok: true,
    issues: issues.filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())),
  };
}
