/**
 * Core types for Ballot Fix phase 0. Nothing here imports a vendor SDK; the
 * research adapter (src/research/anthropic.ts) is the only file that does.
 */

/** Same four evidence types as Parallax Fix, same meaning. */
export const EVIDENCE_TYPES = ["primary_record", "reported", "opinion", "unsourced"] as const;
export type EvidenceType = typeof EVIDENCE_TYPES[number];

export interface RaceQuery {
  city: string;
  /** Two-letter state code, e.g. "CA". */
  state: string;
  /** Office as it appears on the ballot, e.g. "Mayor". */
  office: string;
  /** ISO date of the election, e.g. "2026-11-03". */
  electionDate: string;
}

export interface BallotCandidate {
  name: string;
  /** Occupation/designation printed under the name on the ballot, when known. */
  ballot_designation: string | null;
  incumbent: boolean;
}

/**
 * How the candidate order was established. The overview always shows this,
 * because order on a ballot page carries weight and we must not imply an
 * order we didn't get from an official source.
 */
export const ORDER_BASES = ["official_ballot_order", "official_filing_list", "unofficial"] as const;
export type OrderBasis = typeof ORDER_BASES[number];

export interface BallotListing {
  candidates: BallotCandidate[];
  source_name: string;
  source_url: string | null;
  order_basis: OrderBasis;
  notes: string | null;
  /** See CandidateSource. Absent for an ordinary contest. */
  contest_kind?: ContestKind;
  /** URLs the research session actually retrieved, for provenance checks. */
  retrieved_urls: string[];
}

/**
 * Where a supplied candidate list came from, when it wasn't found by ballot
 * discovery: typed in by the user, or read from a ballot they uploaded.
 */
export interface CandidateSource {
  source_name: string;
  order_basis: OrderBasis;
  notes: string | null;
  /**
   * "retention" for a yes/no judicial retention question: one name, and voters
   * decide whether to keep them. Absent for an ordinary contest.
   */
  contest_kind?: ContestKind;
}

export type ContestKind = "retention";

/** File types a ballot can be uploaded as. Photos and PDFs go through the same reader. */
export const BALLOT_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export type BallotMediaType = typeof BALLOT_MEDIA_TYPES[number];

/** One uploaded photo or PDF of a ballot. Held in memory only, never saved. */
export interface BallotPage {
  media_type: BallotMediaType;
  data: Uint8Array;
}

/** One contest for an elected office, as printed on the voter's ballot. */
export interface BallotContest {
  /** Office title as printed, including district or seat, e.g. "Member, City Council, District 2". */
  office: string;
  /** Who the office belongs to, e.g. "City of Fontana" or "Fontana Unified School District". */
  jurisdiction: string;
  vote_for: number | null;
  /** In the order printed on the ballot. */
  candidates: BallotCandidate[];
}

/**
 * A yes/no item on the ballot: a measure or proposition, or a judicial
 * retention question ("Shall Judge X be elected to the office for the term...").
 */
export interface BallotMeasure {
  kind: "measure" | "retention";
  /** Number or letter as printed, e.g. "Measure X", "Proposition 50". For retention, the office. */
  label: string;
  /** Who put it on the ballot, e.g. "City of Fontana", "State of California". */
  jurisdiction: string;
  /** The ballot question as printed (may be long), or "" if it couldn't be read. */
  question: string;
  /** For retention: the judge's name. "" for a measure. */
  person: string;
}

/**
 * What was read from an uploaded ballot. Deliberately has no field for the
 * voter's name, address, ballot id, or any marks: the reader never reports them.
 */
export interface BallotReading {
  /** ISO date printed on the ballot, when legible. */
  election_date: string | null;
  /** Two-letter state code, when the ballot shows it. */
  state: string | null;
  county: string | null;
  contests: BallotContest[];
  /**
   * Measures and yes/no retention questions, in printed order. Readings saved
   * before these were researched hold bare strings; see measuresOf().
   */
  measures: (BallotMeasure | string)[];
  /** Anything unreadable or uncertain. */
  notes: string | null;
  model: string;
}

/** Reads the contests off photos or PDFs of a voter's own ballot or sample ballot. */
export interface BallotReader {
  readBallot(pages: BallotPage[]): Promise<BallotReading>;
}

/** A fact as the model reported it, before provenance checks. */
export interface RawFact {
  statement: string;
  source_name: string;
  source_url: string;
  author: string | null;
  /** ISO date (or partial date) the source was published, when known. */
  published: string | null;
  /** ISO date (or partial date) of what the statement describes; "" or absent when unknown. */
  event_date?: string | null;
  evidence_type: string;
  /** A short passage copied from the page that supports the statement; "" or absent when none. */
  quote?: string;
}

/**
 * A page the research session opened with web fetch, held in memory for the
 * quote check and never saved. `text` is null when the page's text can't be
 * checked yet (a PDF arrives as base64).
 */
export interface OpenedPage {
  url: string;
  text: string | null;
}

export interface RawSection {
  facts: RawFact[];
  searched: string[];
  gap_note: string | null;
}

/**
 * Web searches and page fetches one research session made, as the API
 * reported them, so effort across candidates can be compared, not assumed.
 * A session that fails throws an Error carrying the same counts as `effort`.
 */
export interface ResearchEffort {
  searches: number;
  fetches: number;
}

/** What a ResearchPort returns for one candidate: unvalidated. */
export interface RawCandidateResearch {
  sections: Record<string, RawSection | undefined>;
  /** Keyed by priority section id (priority_1, ...). */
  stances?: Record<string, RawStance | undefined>;
  identity_note: string | null;
  gaps: string[];
  retrieved_urls: string[];
  /** Pages it opened, for the quote check. Never saved. Absent: none. */
  opened_pages?: OpenedPage[];
  model: string;
  /** Absent from adapters that don't count it. */
  effort?: ResearchEffort;
}

/**
 * How far a verified fact was checked against its page (src/dossier.ts):
 * - quoted: the session opened the page and the fact's quote is on it;
 * - not_found: the session opened and read the page, and the quote isn't on it;
 * - seen: the page was only in search results, or was opened but there was no
 *   quote to check or its text couldn't be read (a PDF, for now).
 * A fact whose URL was never retrieved has no level: it is unverified.
 */
export const CHECK_LEVELS = ["quoted", "not_found", "seen"] as const;
export type CheckLevel = typeof CHECK_LEVELS[number];

export interface FactCheck {
  level: CheckLevel;
  /** The session opened the page, not only saw it in search results. */
  opened: boolean;
  /** The opened page's text was read for the check (false for a PDF). */
  read: boolean;
  /**
   * Set when the page was read and doesn't contain the subject's surname (or
   * a measure's label): the name as looked for. Shown as a flag, never dropped.
   */
  missing_name?: string;
}

export interface Fact {
  statement: string;
  source_name: string;
  source_url: string;
  author: string | null;
  published: string | null;
  /**
   * When what the statement describes happened (a vote, a filing, a ruling,
   * a remark), as an ISO date, month, or year: not the page's date. null when
   * the research gave none in that form; absent on runs saved before event
   * dates, whose sections are ordered by `published` instead.
   */
  event_date?: string | null;
  evidence_type: EvidenceType;
  /** The quote the research gave from the page, when it gave one. Absent on older runs. */
  quote?: string;
  /**
   * The quote check, on verified facts only. Absent on unverified facts and on
   * runs saved before quote checks existed.
   */
  check?: FactCheck;
  /**
   * Other verified facts in the same section that state the same thing, each
   * with its own provenance, folded in by the merge step (src/merge.ts). Each
   * comes from a different publisher. Absent when nothing was merged.
   */
  also?: Fact[];
}

export interface SectionResult {
  facts: Fact[];
  searched: string[];
  /** Always set when facts is empty: an empty section must say why. */
  gap_note: string | null;
}

/**
 * How the sourced record on one of the voter's issues relates to the view
 * they stated. For a measure, it is how a yes vote relates. "no_position"
 * when the voter named only a topic. Never combined into an overall score.
 */
export const STANCES = ["conflicts", "aligns", "mixed", "unclear", "no_position"] as const;
export type Stance = typeof STANCES[number];

/** Findings on one issue the voter said matters to them. Same instruction for everyone. */
export interface PriorityResult {
  issue: string;
  result: SectionResult;
  /** Absent in runs saved before stances existed. */
  stance?: Stance;
  /** One sentence on what the stance rests on, in the researcher's words. */
  stance_basis?: string | null;
  /**
   * Set on every "conflicts", "aligns", or "mixed" stance: "full" when a
   * quoted primary record or quoted facts from two outlets back it, else
   * "thin" (`stanceSupport` in src/dossier.ts). Absent on runs saved before
   * the threshold existed, whose stances count as full.
   */
  stance_strength?: StanceStrength;
}

export type StanceStrength = "full" | "thin";

/** The researcher's stance call for one issue, before validation. */
export interface RawStance {
  stance: string;
  basis: string;
}

export interface CandidateDossier {
  candidate: BallotCandidate;
  /** "pending" only appears in partial results while a run is still in progress. */
  status: "ok" | "failed" | "pending";
  sections: Record<SectionId, SectionResult>;
  /**
   * Facts whose URL was not among the pages the research session actually
   * retrieved. Shown separately and never mixed in with verified facts.
   */
  unverified: Fact[];
  /** Name-collision and identity caveats ("two people named X in the county"). */
  identity_note: string | null;
  /** One entry per issue the voter named for this run, in their order. Absent in older runs. */
  priorities?: PriorityResult[];
  gaps: string[];
  model: string | null;
  /** Searches and fetches its research made. Absent on unfinished runs and ones saved before it existed. */
  effort?: ResearchEffort;
  error: string | null;
}

export interface RaceDossier {
  query: RaceQuery;
  listing: BallotListing;
  /** Issues the voter said matter most to them; [] or absent when none were given. */
  priorities?: string[];
  candidates: CandidateDossier[];
  /** Blind spots that apply to every run of phase 0, shown every time. */
  standing_gaps: string[];
  generated_at: string;
  /** Notes on names in the facts (src/context.ts). Absent until that step has run. */
  context?: ContextResult;
  /** Contributions from campaign finance filings (src/finance.ts). Absent until that step has run. */
  finance?: FinanceResult;
  /** What the office can do (src/office.ts). Absent until that step has run. */
  office?: OfficeResult;
  /**
   * Pages covering every candidate, found once before any candidate's research
   * and put first in each one's prompt (src/shared.ts). Absent on runs saved
   * before the shared pass, and when it was off.
   */
  shared?: SharedSources;
}

/** One ballot measure to research. */
export interface MeasureQuery {
  label: string;
  jurisdiction: string;
  /** Ballot question as printed, when known; helps find the right measure. */
  question: string;
  /** Two-letter state code. */
  state: string;
  electionDate: string;
}

/** What a ResearchPort returns for one measure: unvalidated. */
export interface RawMeasureResearch {
  sections: Record<string, RawSection | undefined>;
  /** Keyed by priority section id (priority_1, ...). */
  stances?: Record<string, RawStance | undefined>;
  /** Official title or name the research found, e.g. "Fontana Parks Sales Tax Measure". */
  official_title: string | null;
  /** Caveats about which measure this is (same letter used elsewhere, renumbered, etc.). */
  identity_note: string | null;
  /** What a yes vote and a no vote each mean, in plain words, one sourced statement each. */
  vote_means?: { yes?: RawFact; no?: RawFact };
  gaps: string[];
  retrieved_urls: string[];
  /** Pages it opened, for the quote check. Never saved. Absent: none. */
  opened_pages?: OpenedPage[];
  model: string;
  /** Absent from adapters that don't count it. */
  effort?: ResearchEffort;
}

/**
 * What a yes vote and a no vote each mean, in plain words, one sourced
 * statement each, written with the same instruction. null when no verified
 * source said it (an unverified one goes to the dossier's unverified list).
 */
export interface VoteMeanings {
  yes: Fact | null;
  no: Fact | null;
}

export interface MeasureDossier {
  query: MeasureQuery;
  status: "ok" | "failed" | "pending";
  official_title: string | null;
  /** Absent on runs saved before it existed. */
  vote_means?: VoteMeanings;
  sections: Record<MeasureSectionId, SectionResult>;
  priorities: PriorityResult[];
  /** Issues the voter said matter most to them; [] when none were given. */
  priority_issues: string[];
  unverified: Fact[];
  identity_note: string | null;
  gaps: string[];
  standing_gaps: string[];
  model: string | null;
  /** Searches and fetches its research made. Absent on unfinished runs and ones saved before it existed. */
  effort?: ResearchEffort;
  error: string | null;
  generated_at: string;
  /** Notes on names in the facts (src/context.ts). Absent until that step has run. */
  context?: ContextResult;
  /** Contributions from campaign finance filings (src/finance.ts). Absent until that step has run. */
  finance?: FinanceResult;
}

/** One section's verified facts, as the merge step shows them to a model. */
export interface MergeBlock {
  /** Who the facts are about and which section, for the model's context only. */
  label: string;
  facts: { id: string; statement: string; source_name: string }[];
}

/**
 * Finds facts that state the same thing. Returns groups of ids, each group
 * drawn from one block; src/merge.ts validates them before anything changes.
 */
export interface ClaimMerger {
  groupDuplicates(blocks: MergeBlock[]): Promise<string[][]>;
}

/**
 * A name found in a run's verified facts, as the context step sends it. The
 * request says where the election is, never which candidate or side the
 * name came from, so every name is looked up the same way.
 */
export interface NameToDescribe {
  id: string;
  name: string;
  /** Statements that name it, cut short, for telling same-named entities apart. */
  mentions: string[];
}

export interface ContextRequest {
  /** City or jurisdiction and state, e.g. "Fontana, CA". */
  place: string;
  electionDate: string;
  names: NameToDescribe[];
}

/** What a ContextWriter returns for one name, before provenance checks. */
export interface RawContextNote {
  id: string;
  /** person, organization, skip (no note needed), or unknown (couldn't identify or source). */
  kind: string;
  note: string;
  source_name: string;
  source_url: string;
  author: string | null;
  published: string | null;
}

export interface RawContextResult {
  notes: RawContextNote[];
  retrieved_urls: string[];
  model: string;
}

/**
 * Writes short, sourced notes on who or what a name is. One capped call per
 * run; src/context.ts picks the names and checks every note that comes back.
 */
export interface ContextWriter {
  describeNames(request: ContextRequest): Promise<RawContextResult>;
}

export const CONTEXT_KINDS = ["person", "organization"] as const;
export type ContextKind = typeof CONTEXT_KINDS[number];

/** Who or what a name in the facts is, with provenance like a fact's. */
export interface ContextNote {
  /** As written in the facts; the page attaches the note where this text appears. */
  name: string;
  kind: ContextKind;
  note: string;
  source_name: string;
  source_url: string;
  author: string | null;
  published: string | null;
  /** False when the cited page was never retrieved: never shown next to the name. */
  verified: boolean;
  /**
   * Set when this run reused the note from an earlier run in the same place
   * instead of looking the name up again: the run whose lookup retrieved the
   * cited page, and when. Absent on a note this run's own lookup wrote.
   */
  reused_from?: { run: string; looked_up: string };
}

/** The context step's result for one run. Absent on runs it didn't reach. */
export interface ContextResult {
  notes: ContextNote[];
  /** Names found in the facts but not sent, over the cap. The page lists them. */
  not_looked_up: string[];
  /** Names sent that came back with no note the page can show. */
  not_described: string[];
  /**
   * Names the model judged need no note: not a specific person or organization,
   * or known to nearly every voter. Listed too. Absent in runs saved before it.
   */
  not_needed?: string[];
  model: string | null;
  /** Why the call failed, when it did; every name found is then in not_looked_up. */
  error?: string;
}

/**
 * Whose money the finance step looks up: a candidate's own committees, or the
 * committees supporting or opposing a measure. The same instruction for each.
 */
export interface FinanceSubject {
  id: string;
  /** The candidate's name, or the measure's label for both sides. */
  name: string;
  role: "candidate" | "support" | "oppose";
}

export interface FinanceRequest {
  /** City or jurisdiction and state, e.g. "Fontana, CA". */
  place: string;
  /** The office, or the measure's label and question. */
  contest: string;
  electionDate: string;
  /** In ballot order; for a measure, support then oppose. */
  subjects: FinanceSubject[];
  /** Most contributions asked for per subject: the same for every subject. */
  perSubject: number;
}

/** One itemized contribution as the model read it off a filing, before checks. */
export interface RawContribution {
  /** The committee that filed the report, as the filing names it. */
  filer: string;
  contributor: string;
  /** individual, organization, or unknown, from the record's contributor code. */
  contributor_type: string;
  occupation: string;
  employer: string;
  amount: string;
  date: string;
  filing_period: string;
  /** Which report and schedule, e.g. "Form 460, Schedule A". */
  filing: string;
  source_name: string;
  source_url: string;
}

/** A total as the filing's summary page records it, before checks. */
export interface RawFinanceTotal {
  filer: string;
  /** The line's own label, e.g. "Total contributions received, calendar year to date". */
  label: string;
  amount: string;
  filing_period: string;
  source_name: string;
  source_url: string;
}

export interface RawFinanceSubject {
  id: string;
  committees: string[];
  searched: string[];
  gap_note: string;
  /** What the filings list beyond what was returned, in the record's terms. */
  not_listed: string;
  totals: RawFinanceTotal[];
  contributions: RawContribution[];
}

/** A filing portal the call couldn't read, and why. */
export interface RawPortalGap {
  portal: string;
  url: string;
  problem: string;
  note: string;
}

export interface RawFinanceResult {
  subjects: RawFinanceSubject[];
  portal_gaps: RawPortalGap[];
  retrieved_urls: string[];
  model: string;
}

/**
 * Reads contributions off campaign finance filings (Form 460 and the like). One
 * capped call per run; src/finance.ts sets the share and checks everything back.
 */
export interface FinanceResearcher {
  findContributions(request: FinanceRequest): Promise<RawFinanceResult>;
}

export const CONTRIBUTOR_TYPES = ["individual", "organization", "unknown"] as const;
export type ContributorType = typeof CONTRIBUTOR_TYPES[number];

/**
 * One itemized contribution, every field as the record states it. Empty
 * optional fields are null. Never rounded, summed, or reworded.
 */
export interface Contribution {
  filer: string;
  contributor: string;
  contributor_type: ContributorType;
  occupation: string | null;
  employer: string | null;
  amount: string;
  date: string | null;
  filing_period: string | null;
  filing: string | null;
  source_name: string;
  source_url: string;
  /** False when the cited page was never retrieved: never shown as fact. */
  verified: boolean;
}

/** A total as recorded on a filing. Only ones on a retrieved page are kept. */
export interface FinanceTotal {
  filer: string;
  label: string;
  amount: string;
  filing_period: string | null;
  source_name: string;
  source_url: string;
}

export const PORTAL_PROBLEMS = [
  "scanned_pdf",
  "login_required",
  "javascript_only",
  "not_found",
  "other",
] as const;
export type PortalProblem = typeof PORTAL_PROBLEMS[number];

export interface PortalGap {
  portal: string;
  url: string | null;
  problem: PortalProblem;
  note: string;
}

/** One candidate's (or one side's) money, as the finance step found it. */
export interface FinanceSubjectResult {
  /** The candidate's name, or the measure's label. */
  subject: string;
  /** For a measure: which side. Absent for a candidate. */
  side?: "support" | "oppose";
  /**
   * For a candidate: their index in the race's candidates. Matched on this,
   * not the name, so two candidates with one name never share a result.
   */
  candidate?: number;
  /** Committees the call looked at, as named. */
  committees: string[];
  totals: FinanceTotal[];
  /** Verified, kept, at most the run's per-subject share. */
  contributions: Contribution[];
  /** Cited a page the call never retrieved. Collapsed on the page, never matched. */
  unverified: Contribution[];
  /** Verified contributions over the share, as "contributor, amount": listed, not kept. */
  left_out: string[];
  /** What the filings list beyond what came back, in the record's terms. */
  not_listed: string | null;
  /** Rows not shown: incomplete, or unverified past the share. */
  dropped: number;
  searched: string[];
  /** Always set when nothing verified was found: say why, never silence. */
  gap_note: string | null;
}

/** The finance step's result for one run. Absent on runs it didn't reach. */
export interface FinanceResult {
  /** In ballot order; for a measure, support then oppose. */
  subjects: FinanceSubjectResult[];
  /** Contributions kept per subject in this run: the same for everyone. */
  per_subject: number;
  portal_gaps: PortalGap[];
  model: string | null;
  /** Why the call failed, when it did; every subject then carries a gap note. */
  error?: string;
}

/** The office a race fills, as the office-powers lookup is asked about it. */
export interface OfficeRequest {
  /** City or jurisdiction and state, e.g. "Fontana, CA". */
  place: string;
  /** The office as the race names it, e.g. "Member, City Council, District 2". */
  office: string;
  electionDate: string;
}

/** What an office-powers lookup returns: unvalidated. Sections keyed by OFFICE_SECTIONS ids. */
export interface RawOfficePowers {
  sections: Record<string, RawSection | undefined>;
  gaps: string[];
  retrieved_urls: string[];
  /** Pages it opened, for the quote check. Never saved. Absent: none. */
  opened_pages?: OpenedPage[];
  model: string;
  effort?: ResearchEffort;
}

/**
 * The voter's issues and the office's verified facts, for marking each issue
 * inside or outside the office's say. No web tools: the marks can rest only
 * on the facts sent.
 */
export interface ScopeRequest {
  place: string;
  office: string;
  facts: { id: string; statement: string }[];
  issues: { id: string; issue: string }[];
}

/** One issue's mark as the model gave it, before checks. */
export interface RawIssueScope {
  id: string;
  scope: string;
  basis: string;
  fact_ids: string[];
}

/**
 * Looks up what an office decides, its budget, seats, and term (one capped
 * call per office, reused across runs in the same place), and marks the
 * voter's issues against it. src/office.ts checks everything that comes back.
 */
export interface OfficeResearcher {
  findOfficePowers(request: OfficeRequest): Promise<RawOfficePowers>;
  markIssueScopes(request: ScopeRequest): Promise<RawIssueScope[]>;
}

/**
 * Whether one of the voter's issues is something the office has a say in.
 * "partly" when it shares the say with other bodies or decides only part of
 * it; "unclear" when the verified facts on the office don't settle it.
 */
export const ISSUE_SCOPES = ["inside", "partly", "outside", "unclear"] as const;
export type IssueScopeValue = typeof ISSUE_SCOPES[number];

/** Where in the office's sections a fact is: what a scope mark cites. */
export interface OfficeFactRef {
  section: OfficeSectionId;
  index: number;
}

export interface IssueScope {
  issue: string;
  scope: IssueScopeValue;
  /** One sentence on what the mark rests on, in the model's words, or why it is unclear. */
  basis: string | null;
  /** The verified facts it cites. Empty for "unclear". */
  rests_on: OfficeFactRef[];
}

/**
 * The office-powers step's result for one race: the same for every candidate.
 * Absent on runs it didn't reach.
 */
export interface OfficeResult {
  /** The office as looked up. */
  office: string;
  sections: Record<OfficeSectionId, SectionResult>;
  unverified: Fact[];
  gaps: string[];
  /** One per issue the voter named for the race, in their order; [] when none. */
  issues: IssueScope[];
  model: string | null;
  /** When this run's lookup ran. Absent when reused (see reused_from) or failed. */
  looked_up?: string;
  /** Searches and fetches the lookup made. Absent when it was reused or failed before counting. */
  effort?: ResearchEffort;
  /**
   * Set when the powers came from an earlier run's lookup of the same office
   * in the same place: that run, and when it was looked up.
   */
  reused_from?: { run: string; looked_up: string };
  /** Why the lookup failed, when it did; every issue is then unclear. */
  error?: string;
  /** Why marking the issues failed, when only that did. */
  scope_error?: string;
}

/**
 * The research port. Phase 0 has one adapter (Claude with server-side web
 * search); later phases add primary-record adapters behind the same shape.
 */
export interface ResearchPort {
  findBallot(query: RaceQuery): Promise<BallotListing>;
  /**
   * `shared`: the race's shared pages, the same for every candidate, put first
   * in the prompt. The caller adds them to what the session retrieved.
   */
  researchCandidate(
    query: RaceQuery,
    candidate: BallotCandidate,
    listing: BallotListing,
    priorities?: readonly string[],
    shared?: readonly SharedPageText[],
  ): Promise<RawCandidateResearch>;
  researchMeasure(
    measure: MeasureQuery,
    priorities?: readonly string[],
  ): Promise<RawMeasureResearch>;
}

// ---------------------------------------------------------------------------
// Shared race-level pass (src/shared.ts)
// ---------------------------------------------------------------------------

/** What kind of page covers the whole race. */
export const SHARED_KINDS = [
  "voter_guide",
  "questionnaire",
  "forum",
  "nonpartisan_guide",
  "other",
] as const;
export type SharedKind = typeof SHARED_KINDS[number];

/** The race, for finding pages that cover every candidate in it. */
export interface SharedRequest {
  /** City or jurisdiction and state, e.g. "Fontana, CA". */
  place: string;
  office: string;
  electionDate: string;
  /** Every candidate's name, in ballot order. */
  candidates: string[];
  /** Most pages to report. */
  max_pages: number;
}

/** One page the shared pass reports: unvalidated. */
export interface RawSharedPage {
  url: string;
  source_name: string;
  title: string;
  kind: string;
}

/** What the shared pass returns: unvalidated. */
export interface RawSharedSources {
  pages: RawSharedPage[];
  gaps: string[];
  retrieved_urls: string[];
  /** Pages it opened: the only text a kept page can carry. Never saved. */
  opened_pages?: OpenedPage[];
  model: string;
  effort?: ResearchEffort;
}

export interface SharedSourceFinder {
  findSharedSources(request: SharedRequest): Promise<RawSharedSources>;
}

/** A kept shared page, as saved: no text. */
export interface SharedPage {
  url: string;
  source_name: string;
  title: string | null;
  kind: SharedKind;
  /** True when its text was cut at SHARED_PAGE_MAX_CHARS before it went to the candidates. */
  cut?: boolean;
}

/**
 * A kept shared page with the text every candidate's research is given. In
 * memory only, like OpenedPage: never saved.
 */
export interface SharedPageText extends SharedPage {
  /** What the candidates see: the page's text, cut at SHARED_PAGE_MAX_CHARS. */
  text: string;
  /** The page's whole text, for the quote check. */
  full_text: string;
}

/** Why a page the shared pass reported wasn't given to the candidates. */
export type SharedLeftOutReason = "not_opened" | "not_read" | "missing_names" | "over_cap";

export interface SharedLeftOut {
  url: string;
  source_name: string;
  reason: SharedLeftOutReason;
  /** For missing_names: the candidates the page (as given) doesn't name, in ballot order. */
  missing?: string[];
}

/** The shared pass as saved on the race. */
export interface SharedSources {
  /** Pages every candidate's research started from, in the order reported. */
  pages: SharedPage[];
  left_out: SharedLeftOut[];
  gaps: string[];
  model: string | null;
  looked_up: string;
  effort?: ResearchEffort;
  /** Set when the call failed: every candidate started without shared pages. */
  error?: string;
  /** Set when the pass didn't run, and why (one candidate). */
  skipped?: string;
}

// Re-exported here so every module agrees on section ids without importing
// the template's prose.
import type { MeasureSectionId, OfficeSectionId, SectionId } from "./template.ts";
export type { MeasureSectionId, OfficeSectionId, SectionId };
