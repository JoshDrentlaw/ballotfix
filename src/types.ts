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
  evidence_type: string;
}

export interface RawSection {
  facts: RawFact[];
  searched: string[];
  gap_note: string | null;
}

/** What a ResearchPort returns for one candidate: unvalidated. */
export interface RawCandidateResearch {
  sections: Record<string, RawSection | undefined>;
  identity_note: string | null;
  gaps: string[];
  retrieved_urls: string[];
  model: string;
}

export interface Fact {
  statement: string;
  source_name: string;
  source_url: string;
  author: string | null;
  published: string | null;
  evidence_type: EvidenceType;
}

export interface SectionResult {
  facts: Fact[];
  searched: string[];
  /** Always set when facts is empty: an empty section must say why. */
  gap_note: string | null;
}

/** Findings on one issue the voter said matters to them. Same instruction for everyone. */
export interface PriorityResult {
  issue: string;
  result: SectionResult;
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
  /** Official title or name the research found, e.g. "Fontana Parks Sales Tax Measure". */
  official_title: string | null;
  /** Caveats about which measure this is (same letter used elsewhere, renumbered, etc.). */
  identity_note: string | null;
  gaps: string[];
  retrieved_urls: string[];
  model: string;
}

export interface MeasureDossier {
  query: MeasureQuery;
  status: "ok" | "failed" | "pending";
  official_title: string | null;
  sections: Record<MeasureSectionId, SectionResult>;
  priorities: PriorityResult[];
  /** Issues the voter said matter most to them; [] when none were given. */
  priority_issues: string[];
  unverified: Fact[];
  identity_note: string | null;
  gaps: string[];
  standing_gaps: string[];
  model: string | null;
  error: string | null;
  generated_at: string;
}

/**
 * The research port. Phase 0 has one adapter (Claude with server-side web
 * search); later phases add primary-record adapters behind the same shape.
 */
export interface ResearchPort {
  findBallot(query: RaceQuery): Promise<BallotListing>;
  researchCandidate(
    query: RaceQuery,
    candidate: BallotCandidate,
    listing: BallotListing,
    priorities?: readonly string[],
  ): Promise<RawCandidateResearch>;
  researchMeasure(
    measure: MeasureQuery,
    priorities?: readonly string[],
  ): Promise<RawMeasureResearch>;
}

// Re-exported here so every module agrees on section ids without importing
// the template's prose.
import type { MeasureSectionId, SectionId } from "./template.ts";
export type { MeasureSectionId, SectionId };
