/**
 * The connections diagnostic: a name held by subjects of two items is
 * reported as connected only when the pages can match it, and otherwise
 * with why not (scope, entity rule, or no tie and the reason).
 */
import { assert, assertEquals } from "@std/assert";
import { contextForMeasure, contextForRace } from "../src/context.ts";
import { diagnose, formatReport } from "../src/diagnose.ts";
import { financeForMeasure } from "../src/finance.ts";
import { runMeasure, runRace } from "../src/race.ts";
import type { BallotRecord, RunRecord } from "../src/web/store.ts";
import type {
  BallotCandidate,
  ContextWriter,
  FinanceResearcher,
  MeasureDossier,
  MeasureQuery,
  RaceDossier,
  RaceQuery,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, raw, rawMeasure } from "./fakes.ts";

const HERALD = "https://www.fontanaherald.com/news/endorsements";
const SOS = "https://cal-access.sos.ca.gov/committee/123";
const FILING = "https://public.netfile.com/pub2/filing/123.pdf";

const fact = (statement: string): RawFact => ({
  statement,
  source_name: "Fontana Herald News",
  source_url: HERALD,
  author: null,
  published: "2026-09-01",
  evidence_type: "reported",
});
const section = (...facts: RawFact[]) => ({ facts, searched: [], gap_note: null });

const notes: ContextWriter = {
  describeNames: (req) =>
    Promise.resolve({
      notes: req.names.map((n) => ({
        id: n.id,
        kind: "organization",
        note: "A political action committee.",
        source_name: "California Secretary of State",
        source_url: SOS,
        author: null,
        published: null,
      })),
      retrieved_urls: [SOS],
      model: "fake",
    }),
};

async function race(
  city: string,
  office: string,
  endorsements: Record<string, string>,
): Promise<RaceDossier> {
  const q: RaceQuery = { city, state: "CA", office, electionDate: "2026-11-03" };
  const cands: BallotCandidate[] = Object.keys(endorsements).map((name) => ({
    name,
    ballot_designation: null,
    incumbent: false,
  }));
  const port = new FakeResearch(
    listing(cands),
    Object.fromEntries(
      Object.entries(endorsements).map(([name, s]) => [
        name,
        raw({ sections: { endorsements: section(fact(s)) }, retrieved_urls: [HERALD] }),
      ]),
    ),
  );
  return await runRace(q, port, { candidates: cands });
}

const MEASURE: MeasureQuery = {
  label: "Measure X",
  jurisdiction: "City of Fontana",
  question: "",
  state: "CA",
  electionDate: "2026-11-03",
};

async function measure(): Promise<MeasureDossier> {
  const port = new FakeResearch(listing([]), {}, {
    "Measure X": rawMeasure({
      sections: {
        case_for: section(fact("Supported by Friends of Fontana Parks.")),
        case_against: section(fact("Opposed by the Fontana Taxpayers Association.")),
      },
      retrieved_urls: [HERALD],
    }),
  });
  const m = (await contextForMeasure(await runMeasure(MEASURE, port), notes)).dossier;
  const money: FinanceResearcher = {
    findContributions: (req) =>
      Promise.resolve({
        subjects: req.subjects.filter((s) => s.role === "support").map((s) => ({
          id: s.id,
          committees: [],
          searched: [],
          gap_note: "",
          not_listed: "",
          totals: [],
          contributions: [{
            filer: "Yes on X",
            contributor: "Inland Builders PAC",
            contributor_type: "organization",
            occupation: "",
            employer: "",
            amount: "$5,000",
            date: "",
            filing_period: "",
            filing: "Form 460",
            source_name: "NetFile",
            source_url: FILING,
          }],
        })),
        portal_gaps: [],
        retrieved_urls: [FILING],
        model: "fake",
      }),
  };
  return (await financeForMeasure(m, money)).dossier;
}

function runOf(id: string, key: string, d: RaceDossier | MeasureDossier): RunRecord {
  const base = {
    id,
    candidates: null,
    status: "done" as const,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    error: null,
    ballot: { id: "b1", key, vote_for: 1 },
  };
  if ("candidates" in d) return { ...base, query: d.query, race: d };
  const q = d.query;
  return {
    ...base,
    query: { city: q.jurisdiction, state: q.state, office: q.label, electionDate: q.electionDate },
    measure: q,
    race: null,
    measure_result: d,
  };
}

const ballot = (started: Record<string, string>): BallotRecord => ({
  id: "b1",
  status: "read",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  error: null,
  pages: 1,
  reading: null,
  started,
});

Deno.test("names across items: connected in one scope, blocked across scopes, untied with why", async () => {
  const council = (await contextForRace(
    await race("Fontana", "City Council", {
      "Jane Roe": "Endorsed by Inland Builders PAC.",
      "Sam Poe": "Endorsed by the Fontana Teachers Union.",
    }),
    notes,
  )).dossier;
  const school = (await contextForRace(
    await race("Fontana Unified School District", "School Board", {
      "Ann Lee": "Endorsed by Inland Builders PAC.",
    }),
    notes,
  )).dossier;
  // No context step here: the union is named, but never a tie.
  const water = await race("Fontana Water District", "Water Board", {
    "Bo Kim": "Endorsed by the Fontana Teachers Union.",
  });
  const runs = new Map([
    ["r0", runOf("r0", "0", council)],
    ["r1", runOf("r1", "1", school)],
    ["r2", runOf("r2", "2", water)],
    ["r3", runOf("r3", "m0", await measure())],
  ]);
  const [report] = diagnose([ballot({ "0": "r0", "1": "r1", "2": "r2", m0: "r3" })], runs);

  assertEquals(report.items.map((i) => i.key), ["0", "1", "2", "m0"]);
  // "City of Fontana" and "Fontana" are one scope; the districts are their own.
  assertEquals(Object.keys(report.scopes).length, 3);

  const by = new Map(report.recurring.map((r) => [r.name, r]));
  const pac = by.get("Inland Builders PAC")!;
  // The council candidate's endorsement and the measure's money meet in one scope.
  assertEquals(pac.verdict, "connected");
  assertEquals(pac.holdings.length, 3);

  const union = by.get("Fontana Teachers Union")!;
  assertEquals(union.verdict, "not tied");
  const untied = union.holdings.find((h) => h.subject === "Bo Kim")!;
  assertEquals(untied.key, null);
  assert(untied.how.includes("context step didn't run"));

  assertEquals(report.totals.connected_across_items, 1);
  assertEquals(report.items[3].subjects[0].finance.kept, 1);
  assert(formatReport([report]).includes("Inland Builders PAC: connected"));
});

Deno.test("the same organization tied in two scopes only is reported as blocked by scope", async () => {
  const council = (await contextForRace(
    await race("Fontana", "City Council", { "Jane Roe": "Endorsed by Inland Builders PAC." }),
    notes,
  )).dossier;
  const school = (await contextForRace(
    await race("Fontana Unified School District", "School Board", {
      "Ann Lee": "Endorsed by Inland Builders PAC.",
    }),
    notes,
  )).dossier;
  const runs = new Map([["r0", runOf("r0", "0", council)], ["r1", runOf("r1", "1", school)]]);
  const [report] = diagnose([ballot({ "0": "r0", "1": "r1" })], runs);
  assertEquals(report.recurring.map((r) => [r.name, r.verdict]), [
    ["Inland Builders PAC", "different scope"],
  ]);
  assertEquals(report.totals.blocked_by_scope, 1);
});

Deno.test("a missing run is listed, not skipped", () => {
  const [report] = diagnose([ballot({ "0": "gone" })], new Map());
  assertEquals(report.items[0].status, "missing");
  assertEquals(report.recurring, []);
});
