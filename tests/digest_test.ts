import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import { digestHash, isCurrent, planRace, runPlan } from "../src/digest.ts";
import type {
  BallotCandidate,
  Digester,
  DigestRequest,
  RaceDossier,
  RawDigest,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw } from "./fakes.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { openStores } from "../src/web/store.ts";

const CANDS: BallotCandidate[] = [
  { name: "Joz Sida", ballot_designation: null, incumbent: false },
  { name: "Ana Reyes", ballot_designation: null, incumbent: true },
];
const HERALD = "https://www.fontanaherald.com/news/forum";
const DAILY = "https://inlanddaily.example/race";
const NOW = new Date("2026-11-03T12:00:00Z");

function fact(statement: string, source_name: string, source_url: string): RawFact {
  return {
    statement,
    source_name,
    source_url,
    author: null,
    published: "2026-10-01",
    evidence_type: "reported",
  };
}

async function race(): Promise<RaceDossier> {
  const research = (who: string) =>
    raw({
      sections: {
        platform: {
          facts: [
            fact(`${who} wants more parks.`, "Fontana Herald News", HERALD),
            fact(`${who} said rents are too high.`, "Inland Daily", DAILY),
          ],
          searched: [],
          gap_note: null,
        },
        record: {
          facts: [fact(`${who} voted for the budget.`, "Inland Daily", DAILY)],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: [HERALD, DAILY],
    });
  const port = new FakeResearch(listing(CANDS), {
    "Joz Sida": research("Joz Sida"),
    "Ana Reyes": research("Ana Reyes"),
  });
  return await runRace(QUERY, port, { candidates: CANDS });
}

/** Answers from a script: one function per call, so a test can fix the second answer. */
class Scripted implements Digester {
  calls: DigestRequest[] = [];
  constructor(private readonly answers: ((r: DigestRequest) => RawDigest)[]) {}
  digestFacts(r: DigestRequest): Promise<RawDigest> {
    this.calls.push(r);
    return Promise.resolve(this.answers[Math.min(this.calls.length, this.answers.length) - 1](r));
  }
}

/** A fair answer: each summarized section's first line cites all its facts. */
function fair(r: DigestRequest, say = (name: string) => `${name}'s facts, in short.`): RawDigest {
  return {
    subjects: r.subjects.map((s) => ({
      id: s.id,
      brief: s.brief
        ? [{ text: say(s.name), facts: s.sections.flatMap((x) => x.facts.map((f) => f.id)) }]
        : [],
      sections: s.sections.filter((x) => x.summarize).map((x) => ({
        id: x.id,
        lines: [{ text: say(s.name), facts: x.facts.map((f) => f.id) }],
      })),
    })),
  };
}

Deno.test("a digest is asked only of sections with two or more facts, and a brief of four", async () => {
  const p = planRace(await race(), "m", NOW)!;
  assertEquals(p.request.subjects.length, 2);
  const s = p.request.subjects[0];
  assertEquals(s.brief, false); // three facts
  assertEquals(
    s.sections.map((x) => [x.id, x.summarize, x.facts.length]),
    [["record", false, 1], ["platform", true, 2]],
  );
  assertEquals(s.sections[1].facts[0].sources, ["Fontana Herald News"]);
  // The hash is the facts and the model, never the clock.
  assertEquals(p.hash, planRace(await race(), "m", new Date())!.hash);
  assert(p.hash !== planRace(await race(), "other", NOW)!.hash);
  assertEquals(p.hash, digestHash(p.request, "m"));
});

Deno.test("a fair digest is kept, shown over its facts with each line's outlets, and not made twice", async () => {
  const r = await race();
  const p = planRace(r, "m", NOW)!;
  const d = new Scripted([
    (req) => fair(req, () => "Fontana Herald News and Inland Daily report on parks and rents."),
  ]);
  const { dossier, calls } = await runPlan(p, d);
  assertEquals(calls, 1);
  const lines = dossier.digest!.subjects[0].sections.platform;
  assertEquals(lines[0].facts, [{ section: "platform", index: 0 }, {
    section: "platform",
    index: 1,
  }]);
  assert(isCurrent(dossier, planRace(dossier, "m", NOW)!));
  const page = renderRace(dossier);
  assertStringIncludes(page, "In short");
  assertStringIncludes(page, "Fontana Herald News, Inland Daily · 2 facts");
  // The facts are still there under it.
  assertStringIncludes(page, "Joz Sida wants more parks.");
});

Deno.test("a line citing another section's fact, an outlet not its own, or another candidate is left out for everyone", async () => {
  const r = await race();
  const bad: [string, (req: DigestRequest) => RawDigest][] = [
    ["cites f1, which isn't one of its facts", (req) => {
      const a = fair(req);
      a.subjects[0].sections[0].lines[0].facts.push("f1");
      return a;
    }],
    ["names KQED, which none of its facts name", (req) => {
      const a = fair(req);
      a.subjects[0].sections[0].lines[0].text = "KQED reports parks.";
      return a;
    }],
    ["names Reyes, whom none of its facts name", (req) => {
      const a = fair(req);
      a.subjects[0].sections[0].lines[0].text = "Unlike Reyes, Sida wants parks.";
      return a;
    }],
    ['says "controversial"', (req) => {
      const a = fair(req);
      a.subjects[0].sections[0].lines[0].text = "A controversial plan for parks.";
      return a;
    }],
  ];
  for (const [why, answer] of bad) {
    const d = new Scripted([answer]);
    const { dossier, calls } = await runPlan(planRace(r, "m", NOW)!, d);
    assertEquals(calls, 2, why); // sent back once, with what was wrong
    assertStringIncludes(d.calls[1].problems!.join(" "), why);
    const [sida, reyes] = dossier.digest!.subjects;
    assertEquals(sida.sections.platform, undefined, why);
    assertEquals(reyes.sections.platform, undefined, why);
    assert(sida.left_out[0].reason.startsWith("a line "), why);
    assertStringIncludes(reyes.left_out[0].reason, "left out for every candidate");
    assertStringIncludes(renderRace(dossier), "No summary here:");
  }
});

Deno.test("a second answer that fixes the problem is kept", async () => {
  const d = new Scripted([
    (req) => {
      const a = fair(req);
      a.subjects[1].sections[0].lines = [];
      return a;
    },
    (req) => fair(req),
  ]);
  const { dossier, calls, left_out } = await runPlan(planRace(await race(), "m", NOW)!, d);
  assertEquals([calls, left_out], [2, 0]);
  assertStringIncludes(d.calls[1].problems![0], "s2 platform: no summary was given");
  assert(dossier.digest!.subjects.every((s) => s.sections.platform?.length === 1));
});

Deno.test("a failed call is recorded and the page says there are no summaries", async () => {
  const { digestFailed } = await import("../src/digest.ts");
  const r = digestFailed(planRace(await race(), "m", NOW)!, "the model declined");
  assertStringIncludes(renderRace(r), "No summaries for this run: the model declined.");
});

Deno.test("the job runner digests a finished run after its other steps", async () => {
  const s = await openStores(await Deno.makeTempDir());
  const research = (who: string) =>
    raw({
      sections: {
        platform: {
          facts: [
            fact(`${who} wants more parks.`, "Fontana Herald News", HERALD),
            fact(`${who} said rents are too high.`, "Inland Daily", DAILY),
          ],
          searched: [],
          gap_note: null,
        },
      },
      retrieved_urls: [HERALD, DAILY],
    });
  const port = new FakeResearch(listing(CANDS), {
    "Joz Sida": research("Joz Sida"),
    "Ana Reyes": research("Ana Reyes"),
  });
  const d = new Scripted([(req) => fair(req)]);
  const logs: string[] = [];
  const jobs = new JobRunner(s.runs, () => port, {
    log: (m) => logs.push(m),
    makeDigester: () => d,
    digestModel: "m",
  });
  const run = await jobs.submit(QUERY, CANDS);
  await jobs.idle();
  const saved = (await s.runs.get(run.id))!;
  assertEquals(d.calls.length, 1);
  assertEquals(saved.race!.digest!.subjects[1].sections.platform.length, 1);
  assert(logs.some((l) => l.includes("digested 4 facts in 1 call(s), 0 left out")));
  s.db.close();
});

Deno.test("a name its facts mention, an abbreviation of one, and a hyphenated word all stand", async () => {
  const r = await race();
  for (
    const text of [
      "Inland Daily and Fontana Herald News report Joz Sida wants parks.",
      "The Fontana Herald News (FHN) reports Joz Sida wants parks.",
      "Inland Daily-affiliated reporting says rents are too high.",
    ]
  ) {
    const d = new Scripted([(req) => {
      const a = fair(req);
      a.subjects[0].sections[0].lines[0].text = text;
      return a;
    }]);
    const { calls, left_out } = await runPlan(planRace(r, "m", NOW)!, d);
    assertEquals([calls, left_out], [1, 0], text);
  }
});
