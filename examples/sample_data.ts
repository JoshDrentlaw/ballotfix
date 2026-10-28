/**
 * Placeholder data for the layout sample and the demo server. Not research
 * about real people: every name and statement is labeled as a placeholder.
 */
import type {
  BallotListing,
  BallotReader,
  BallotReading,
  ClaimMerger,
  ContextWriter,
  FinanceResearcher,
  RawCandidateResearch,
  RawContribution,
  RawFinanceSubject,
  RawMeasureResearch,
  ResearchPort,
} from "../src/types.ts";

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
    endorsements: {
      facts: [{
        statement:
          "Placeholder: endorsed by Example Builders PAC and the Example Labor Council Local 99.",
        source_name: "Example News",
        source_url: "https://example.org/news/endorsements",
        author: null,
        published: "2026-09-02",
        evidence_type: "opinion",
      }],
      searched: ["local news endorsements"],
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
        statement:
          "Placeholder: the city was sued by the state attorney general over the warehouse.",
        source_name: "Example Daily",
        source_url: "https://example.org/daily/2",
        author: null,
        published: "2021-07-16",
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
  retrieved_urls: [
    "https://example.org/mayor",
    "https://example.org/news/endorsements",
    "https://example.org/news/1",
    "https://example.org/daily/2",
  ],
  model: "layout-sample",
};

export const sampleReading: BallotReading = {
  election_date: "2026-11-03",
  state: "CA",
  county: "Example County (placeholder)",
  contests: [
    {
      office: "Mayor",
      jurisdiction: "City of Example",
      vote_for: 1,
      candidates: listing.candidates,
    },
    {
      office: "Member, City Council, District 2",
      jurisdiction: "City of Example",
      vote_for: 1,
      candidates: [
        { name: "Sample Candidate D", ballot_designation: "Councilmember", incumbent: true },
        { name: "Sample Candidate E", ballot_designation: "Teacher", incumbent: false },
      ],
    },
    {
      office: "Governing Board Member, Trustee Area 4",
      jurisdiction: "Example Unified School District",
      vote_for: 1,
      candidates: [
        { name: "Sample Candidate F", ballot_designation: "Parent", incumbent: false },
      ],
    },
  ],
  measures: [
    {
      kind: "measure",
      label: "Measure X",
      jurisdiction: "City of Example",
      question:
        "PLACEHOLDER. Shall the measure establishing a one-half cent sales tax for parks, providing about $10 million a year until ended by voters, be adopted?",
      person: "",
    },
    {
      kind: "retention",
      label: "Associate Justice, Court of Appeal (placeholder)",
      jurisdiction: "State of Example",
      question:
        "PLACEHOLDER. Shall Sample Judge G be elected to the office for the term provided by law?",
      person: "Sample Judge G",
    },
  ],
  notes: "LAYOUT SAMPLE. Placeholder contests, not read from your upload.",
  model: "layout-sample",
};

export const measureFacts: RawMeasureResearch = {
  vote_means: {
    yes: {
      statement:
        "Placeholder: A YES vote means the city adds a half-cent sales tax for 20 years, spent only on parks.",
      source_name: "Example City Attorney, impartial analysis",
      source_url: "https://example.org/measure-x/analysis.pdf",
      author: null,
      published: "2026-08",
      evidence_type: "primary_record",
    },
    no: {
      statement:
        "Placeholder: A NO vote means the sales tax rate stays where it is and parks keep their current funding.",
      source_name: "Example City Attorney, impartial analysis",
      source_url: "https://example.org/measure-x/analysis.pdf",
      author: null,
      published: "2026-08",
      evidence_type: "primary_record",
    },
  },
  sections: {
    effect: {
      facts: [{
        statement:
          "Placeholder: a yes vote adds a half-cent sales tax for parks; a no vote leaves the rate as it is.",
        source_name: "Example City Attorney, impartial analysis",
        source_url: "https://example.org/measure-x/analysis.pdf",
        author: null,
        published: "2026-08",
        evidence_type: "primary_record",
      }],
      searched: ["county voter information guide"],
      gap_note: null,
    },
    history: {
      facts: [{
        statement: "Placeholder: the city council placed it on the ballot by a 4-1 vote.",
        source_name: "Example City Council minutes",
        source_url: "https://example.org/minutes/2026-07-08",
        author: null,
        published: "2026-07-08",
        evidence_type: "primary_record",
      }],
      searched: ["council agendas and minutes"],
      gap_note: null,
    },
    case_for: {
      facts: [{
        statement: "Placeholder: the ballot argument for it is signed by Friends of Example Parks.",
        source_name: "Example County voter guide",
        source_url: "https://example.org/measure-x/arguments.pdf",
        author: null,
        published: "2026-08",
        evidence_type: "opinion",
      }],
      searched: ["voter guide ballot arguments"],
      gap_note: null,
    },
    case_against: {
      facts: [{
        statement:
          "Placeholder: the ballot argument against it is signed by the Example Taxpayers Association.",
        source_name: "Example County voter guide",
        source_url: "https://example.org/measure-x/arguments.pdf",
        author: null,
        published: "2026-08",
        evidence_type: "opinion",
      }],
      searched: ["voter guide ballot arguments"],
      gap_note: null,
    },
    priority_1: {
      facts: [{
        statement: "Placeholder: the analysis says revenue may be spent only on park maintenance.",
        source_name: "Example City Attorney, impartial analysis",
        source_url: "https://example.org/measure-x/analysis.pdf",
        author: null,
        published: "2026-08",
        evidence_type: "primary_record",
      }],
      searched: ["impartial analysis"],
      gap_note: null,
    },
  },
  stances: {
    priority_1: {
      stance: "aligns",
      basis: "Placeholder: the analysis restricts the revenue to parks.",
    },
  },
  official_title: "Example City Parks Sales Tax Measure (placeholder)",
  identity_note: null,
  gaps: ["Placeholder: committee filings for the No side were not online."],
  retrieved_urls: [
    "https://example.org/measure-x/analysis.pdf",
    "https://example.org/measure-x/arguments.pdf",
    "https://example.org/minutes/2026-07-08",
  ],
  model: "layout-sample",
};

/** Fake ballot reader: ignores the upload and returns the placeholder ballot. */
export function sampleBallotReader(delayMs = 0): BallotReader {
  return {
    readBallot: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return sampleReading;
    },
  };
}

/** Fake research port; delayMs simulates how long real research takes. */
/** Placeholder merge: in each block, the facts about the warehouse are one fact. */
export function sampleMerger(delayMs = 0): ClaimMerger {
  return {
    groupDuplicates: async (blocks) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return blocks.map((b) =>
        b.facts.filter((f) => f.statement.includes("warehouse")).map((f) => f.id)
      );
    },
  };
}

/** Placeholder notes, keyed by name. One cites a page never retrieved, so that case shows too. */
const SAMPLE_NOTES: Record<string, { kind: string; note: string; url: string }> = {
  "Example Builders PAC": {
    kind: "organization",
    note: "Placeholder: a political action committee formed by home builders in Example County.",
    url: "https://example.org/sos/committees/123",
  },
  "Example Labor Council Local 99": {
    kind: "organization",
    note: "Placeholder: a council of construction trade unions in Example County.",
    url: "https://example.org/never-opened/labor",
  },
  "Friends of Example Parks": {
    kind: "organization",
    note: "Placeholder: a ballot measure committee formed to support Measure X.",
    url: "https://example.org/sos/committees/456",
  },
  "Example Taxpayers Association": {
    kind: "organization",
    note: "Placeholder: a nonprofit that takes positions on local tax measures in Example County.",
    url: "https://example.org/eta/about",
  },
};

/** Placeholder context notes; names it has no note for come back "unknown". */
export function sampleContextWriter(delayMs = 0): ContextWriter {
  return {
    describeNames: async ({ names }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        notes: names.map((n) => {
          const s = SAMPLE_NOTES[n.name];
          return {
            id: n.id,
            kind: s?.kind ?? "unknown",
            note: s?.note ?? "",
            source_name: s ? "Example Secretary of State (placeholder)" : "",
            source_url: s?.url ?? "",
            author: null,
            published: s ? "2026-07" : null,
          };
        }),
        retrieved_urls: Object.values(SAMPLE_NOTES).map((s) => s.url)
          .filter((u) => !u.includes("never-opened")),
        model: "layout-sample",
      };
    },
  };
}

const FILING_A = "https://example.org/netfile/filings/a-460.pdf";
const FILING_B = "https://example.org/netfile/filings/b-460.pdf";
const FILING_YES = "https://example.org/netfile/filings/yes-460.pdf";
const FILING_NO = "https://example.org/netfile/filings/no-460.pdf";

function gift(
  filer: string,
  contributor: string,
  amount: string,
  url: string,
  extra: Partial<RawContribution> = {},
): RawContribution {
  return {
    filer,
    contributor,
    contributor_type: "organization",
    occupation: "",
    employer: "",
    amount,
    date: "09/14/2026",
    filing_period: "07/01/2026 - 09/19/2026",
    filing: "Form 460, Schedule A (placeholder)",
    source_name: "Example City Clerk, NetFile (placeholder)",
    source_url: url,
    ...extra,
  };
}

const person = (occupation: string, employer: string) => ({
  contributor_type: "individual",
  occupation,
  employer,
});

/**
 * Placeholder filings, by position on the ballot: the first two candidates
 * share a PAC and a donor, and have two near-miss company names; the rest
 * have none found. The measure's two sides share a PAC and a near miss.
 */
const SAMPLE_FILINGS: Omit<RawFinanceSubject, "id">[] = [
  {
    committees: ["Placeholder A for Mayor 2026"],
    searched: ["city clerk NetFile portal (placeholder)"],
    gap_note: "",
    not_listed: "",
    totals: [{
      filer: "Placeholder A for Mayor 2026",
      label: "Total contributions received, calendar year to date",
      amount: "$18,450.00",
      filing_period: "01/01/2026 - 09/19/2026",
      source_name: "Example City Clerk, NetFile (placeholder)",
      source_url: FILING_A,
    }],
    contributions: [
      gift("Placeholder A for Mayor 2026", "Example Builders PAC", "$1,000.00", FILING_A),
      gift("Placeholder A for Mayor 2026", "Pat Placeholder", "$250.00", FILING_A, {
        ...person("Engineer", "Example Engineering Co"),
      }),
      gift("Placeholder A for Mayor 2026", "Smith Development", "$500.00", FILING_A),
      gift("Placeholder A for Mayor 2026", "Lee Placeholder", "$100.00", FILING_A, {
        ...person("Retired", ""),
      }),
      gift("Placeholder A for Mayor 2026", "Example Blog Readers", "$50.00", FILING_A, {
        source_url: "https://example.org/never-opened/filing",
      }),
    ],
  },
  {
    committees: ["Placeholder B for Mayor 2026"],
    searched: ["city clerk NetFile portal (placeholder)"],
    gap_note: "",
    not_listed: "Placeholder: the 460 lists 38 more itemized contributions under $100.",
    totals: [],
    contributions: [
      gift("Placeholder B for Mayor 2026", "Example Builders PAC", "$2,500.00", FILING_B),
      gift("Placeholder B for Mayor 2026", "Pat Placeholder", "$100.00", FILING_B, {
        ...person("Engineer", "Example Engineering Co"),
      }),
      gift("Placeholder B for Mayor 2026", "Smith Development LLC", "$750.00", FILING_B),
      gift("Placeholder B for Mayor 2026", "Lee Placeholder", "$100.00", FILING_B, {
        ...person("Retired", ""),
      }),
    ],
  },
];

const SAMPLE_SIDES: Record<"support" | "oppose", Omit<RawFinanceSubject, "id">> = {
  support: {
    committees: ["Yes on Example Parks, Measure X (placeholder)"],
    searched: ["city clerk NetFile portal (placeholder)"],
    gap_note: "",
    not_listed: "",
    totals: [],
    contributions: [
      gift("Yes on Example Parks", "Example Builders PAC", "$5,000.00", FILING_YES),
      gift("Yes on Example Parks", "Example Developers LLC", "$2,000.00", FILING_YES),
    ],
  },
  oppose: {
    committees: ["No on Measure X Taxpayers Committee (placeholder)"],
    searched: ["city clerk NetFile portal (placeholder)"],
    gap_note: "",
    not_listed: "",
    totals: [],
    contributions: [
      gift("No on Measure X", "Example Builders PAC", "$250.00", FILING_NO),
      gift("No on Measure X", "Example Developers", "$500.00", FILING_NO),
    ],
  },
};

/** Placeholder finance lookup; same shape as the real one's answer. */
export function sampleFinanceResearcher(delayMs = 0): FinanceResearcher {
  return {
    findContributions: async ({ subjects }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      const empty = {
        committees: [],
        searched: ["city clerk NetFile portal (placeholder)"],
        gap_note: "Placeholder: no committee for this candidate was found on the portal.",
        not_listed: "",
        totals: [],
        contributions: [],
      };
      return {
        subjects: subjects.map((s, i) => ({
          id: s.id,
          ...(s.role === "candidate" ? SAMPLE_FILINGS[i] ?? empty : SAMPLE_SIDES[s.role]),
        })),
        portal_gaps: [{
          portal: "Example County Registrar e-filing (placeholder)",
          url: "https://example.org/county/efile",
          problem: "javascript_only",
          note: "Placeholder: the search page loads its results with JavaScript.",
        }],
        retrieved_urls: [FILING_A, FILING_B, FILING_YES, FILING_NO],
        model: "layout-sample",
      };
    },
  };
}

export function samplePort(delayMs = 0): ResearchPort {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    findBallot: async () => {
      await wait();
      return listing;
    },
    researchCandidate: async (_q, c, _l, priorities = []) => {
      await wait();
      await wait();
      if (c.name.endsWith("C")) throw new Error("placeholder failure");
      const base = c.incumbent ? withFacts : { ...withFacts, identity_note: null, gaps: [] };
      if (!priorities.length) return base;
      // Placeholder stance on the first issue, backed by a retrieved page, so the layout shows.
      return {
        ...base,
        sections: { ...base.sections, priority_1: base.sections.criticisms },
        stances: {
          priority_1: c.incumbent
            ? { stance: "conflicts", basis: "Placeholder: the warehouse approval cited above." }
            : { stance: "unclear", basis: "" },
        },
      };
    },
    researchMeasure: async () => {
      await wait();
      return measureFacts;
    },
  };
}
