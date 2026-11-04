import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { raceConnections } from "../src/finance.ts";
import { runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import { planRaceTies, runTies } from "../src/ties.ts";
import type {
  BallotCandidate,
  ContextNote,
  RaceDossier,
  RawFact,
  RawTieRole,
  TieRoleMarker,
  TieRoleRequest,
} from "../src/types.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { openStores } from "../src/web/store.ts";
import { FakeResearch, listing, QUERY, raw } from "./fakes.ts";

const CANDS: BallotCandidate[] = [
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
  { name: "Ana Reyes", ballot_designation: null, incumbent: true },
];
const PAGE = "https://inlanddaily.example/endorsements";
const NOW = new Date("2026-11-03T12:00:00Z");

const note = (name: string): ContextNote => ({
  name,
  kind: "organization",
  note: `${name} is a local group.`,
  source_name: "Example",
  source_url: "https://example.org/about",
  author: null,
  published: null,
  verified: true,
});

function fact(statement: string): RawFact {
  return {
    statement,
    source_name: "Inland Daily",
    source_url: PAGE,
    author: null,
    published: "2026-10-01",
    evidence_type: "reported",
  };
}

async function race(): Promise<RaceDossier> {
  const research = (facts: string[]) =>
    raw({
      sections: { endorsements: { facts: facts.map(fact), searched: [], gap_note: null } },
      retrieved_urls: [PAGE],
    });
  const port = new FakeResearch(listing(CANDS), {
    "Joz Sida": research(["Sida was endorsed by the Fontana Teachers Association."]),
    "Ana Reyes": research([
      "The Fontana Teachers Association recommends a NO vote on Reyes.",
      "Reyes is listed by the Inland Voter Guide.",
    ]),
  });
  const r = await runRace(QUERY, port, { candidates: CANDS });
  return {
    ...r,
    context: {
      notes: [note("Fontana Teachers Association"), note("Inland Voter Guide")],
      not_looked_up: [],
      not_described: [],
      model: "test",
    },
  };
}

class Marker implements TieRoleMarker {
  calls: TieRoleRequest[] = [];
  constructor(private readonly answer: (r: TieRoleRequest) => RawTieRole[]) {}
  markTieRoles(r: TieRoleRequest): Promise<RawTieRole[]> {
    this.calls.push(r);
    return Promise.resolve(this.answer(r));
  }
}

/** What a careful marker would say, by the fact's words. */
const careful = (r: TieRoleRequest): RawTieRole[] =>
  r.ties.map((t) =>
    /endorsed by/.test(t.statement)
      ? { id: t.id, role: "supports", words: "endorsed by" }
      : /NO vote/.test(t.statement)
      ? { id: t.id, role: "opposes", words: "recommends a NO vote" }
      : { id: t.id, role: "reported", words: "listed by" }
  );

Deno.test("each named tie is sent with its fact and subject, and nothing else", async () => {
  const p = planRaceTies(await race(), "m", NOW)!;
  assertEquals(p.request.ties.map((t) => [t.name, t.subject]), [
    ["Fontana Teachers Association", "the candidate Joz Sida"],
    ["Fontana Teachers Association", "the candidate Ana Reyes"],
    ["Inland Voter Guide", "the candidate Ana Reyes"],
  ]);
});

Deno.test("a mark stands only on the fact's own words, and the page shows them", async () => {
  const r = await race();
  const { dossier, marked } = await runTies(planRaceTies(r, "m", NOW)!, new Marker(careful));
  assertEquals(marked, 3);
  const [pair] = raceConnections(dossier);
  const shared = pair.shared.find((s) => s.ref.name === "Fontana Teachers Association")!;
  const role = (ties: typeof shared.a) => ties[0].kind === "named" ? ties[0].mark?.role : null;
  assertEquals([role(shared.a), role(shared.b)], ["supports", "opposes"]);
  const page = renderRace(dossier);
  assertStringIncludes(page, `<span class="tie-role">supports</span>`);
  assertStringIncludes(page, "(“recommends a NO vote”)");
});

Deno.test("a role without the fact's words, words from outside it, or the name alone is no mark", async () => {
  const r = await race();
  const bad = new Marker((req) => [
    { id: req.ties[0].id, role: "supports", words: "strongly backs" }, // not in the fact
    { id: req.ties[1].id, role: "opposes", words: "Fontana Teachers Association" }, // the name
    { id: req.ties[2].id, role: "other", words: "" },
    { id: "t99", role: "supports", words: "listed by" },
  ]);
  const { dossier, marked } = await runTies(planRaceTies(r, "m", NOW)!, bad);
  assertEquals(marked, 0);
  const page = renderRace(dossier);
  assert(!page.includes(`class="tie-role"`));
  assertStringIncludes(page, "named in Endorsements and affiliations");
});

Deno.test("the job runner marks a finished run's ties", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const r = await race();
  // The context step would write these notes; here they come with the research.
  const port = new FakeResearch(listing(CANDS), {
    "Joz Sida": raw({
      sections: {
        endorsements: {
          facts: [fact(r.candidates[0].sections.endorsements.facts[0].statement)],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: [PAGE],
    }),
    "Ana Reyes": raw(),
  });
  const marker = new Marker(careful);
  const jobs = new JobRunner(s.runs, () => port, {
    makeContextWriter: () => ({
      describeNames: (req) =>
        Promise.resolve({
          notes: req.names.map((n) => ({
            id: n.id,
            kind: "organization",
            note: "A local group.",
            source_name: "Example",
            source_url: "https://example.org/about",
            author: null,
            published: null,
          })),
          retrieved_urls: ["https://example.org/about"],
          model: "test",
        }),
    }),
    makeTieMarker: () => marker,
    tiesModel: "m",
  });
  const run = await jobs.submit(QUERY, CANDS);
  await jobs.idle();
  const saved = (await s.runs.get(run.id))!;
  assertEquals(marker.calls.length, 1);
  assertEquals(saved.race!.tie_roles?.marks.map((m) => m.role), ["supports"]);
  s.db.close();
});
