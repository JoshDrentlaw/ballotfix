/**
 * Placeholder data for the layout sample and the demo server. Not research
 * about real people: every name and statement is labeled as a placeholder.
 */
import type { BallotListing, RawCandidateResearch, ResearchPort } from "../src/types.ts";

export const listing: BallotListing = {
  candidates: [
    { name: "Sample Candidate A", ballot_designation: "Small Business Owner", incumbent: false },
    { name: "Sample Candidate B", ballot_designation: "Mayor", incumbent: true },
    { name: "Sample Candidate C", ballot_designation: null, incumbent: false },
  ],
  source_name: "Example City Clerk, Notice of Nominees (placeholder)",
  source_url: "https://example.org/nominees.pdf",
  order_basis: "official_filing_list",
  notes: "LAYOUT SAMPLE. Placeholder data, not research about real people.",
  retrieved_urls: [],
};

export const withFacts: RawCandidateResearch = {
  sections: {
    background: {
      facts: [{
        statement:
          "Placeholder: served on the city council from 2006 to 2010 before becoming mayor.",
        source_name: "Example City",
        source_url: "https://example.org/mayor",
        author: null,
        published: "2024",
        evidence_type: "primary_record",
      }],
      searched: ["city website biography", "county registrar"],
      gap_note: null,
    },
    criticisms: {
      facts: [{
        statement:
          "Placeholder: the state attorney general sued the city over a warehouse approval.",
        source_name: "Example News",
        source_url: "https://example.org/news/1",
        author: "A. Reporter",
        published: "2021-07-15",
        evidence_type: "reported",
      }, {
        statement: "Placeholder: a claim whose cited page was never opened.",
        source_name: "Example Blog",
        source_url: "https://example.org/never-opened",
        author: null,
        published: null,
        evidence_type: "opinion",
      }],
      searched: ["state AG press releases", "local news archive"],
      gap_note: null,
    },
  },
  identity_note: "Placeholder: another person with this name serves on a county board.",
  gaps: ["Placeholder: the campaign finance portal could not be searched."],
  retrieved_urls: ["https://example.org/mayor", "https://example.org/news/1"],
  model: "layout-sample",
};

/** Fake research port; delayMs simulates how long real research takes. */
export function samplePort(delayMs = 0): ResearchPort {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    findBallot: async () => {
      await wait();
      return listing;
    },
    researchCandidate: async (_q, c) => {
      await wait();
      await wait();
      if (c.name.endsWith("C")) throw new Error("placeholder failure");
      return c.incumbent ? withFacts : { ...withFacts, identity_note: null, gaps: [] };
    },
  };
}
