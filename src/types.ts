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
  /** URLs the research session actually retrieved, for provenance checks. */
  retrieved_urls: string[];
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
  gaps: string[];
  model: string | null;
  error: string | null;
}

export interface RaceDossier {
  query: RaceQuery;
  listing: BallotListing;
  candidates: CandidateDossier[];
  /** Blind spots that apply to every run of phase 0, shown every time. */
  standing_gaps: string[];
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
  ): Promise<RawCandidateResearch>;
}

// Re-exported here so every module agrees on section ids without importing
// the template's prose.
import type { SectionId } from "./template.ts";
export type { SectionId };
