import type {
  BallotCandidate,
  BallotListing,
  RaceQuery,
  RawCandidateResearch,
  ResearchPort,
} from "../src/types.ts";

export const QUERY: RaceQuery = {
  city: "Fontana",
  state: "CA",
  office: "Mayor",
  electionDate: "2026-11-03",
};

export function listing(candidates: BallotCandidate[]): BallotListing {
  return {
    candidates,
    source_name: "City Clerk, Notice of Nominees",
    source_url: "https://www.fontanaca.gov/nominees.pdf",
    order_basis: "official_filing_list",
    notes: null,
    retrieved_urls: ["https://www.fontanaca.gov/nominees.pdf"],
  };
}

export function raw(overrides: Partial<RawCandidateResearch> = {}): RawCandidateResearch {
  return {
    sections: {},
    identity_note: null,
    gaps: [],
    retrieved_urls: [],
    model: "fake",
    ...overrides,
  };
}

/** Research port that returns canned results per candidate name, or throws. */
export class FakeResearch implements ResearchPort {
  calls: string[] = [];
  constructor(
    readonly ballot: BallotListing,
    readonly results: Record<string, RawCandidateResearch | Error>,
  ) {}
  findBallot(): Promise<BallotListing> {
    this.calls.push("ballot");
    return Promise.resolve(this.ballot);
  }
  researchCandidate(_q: RaceQuery, c: BallotCandidate): Promise<RawCandidateResearch> {
    this.calls.push(c.name);
    const r = this.results[c.name];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r ?? raw());
  }
}
