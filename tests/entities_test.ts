/**
 * Entity pages (knowledge-base step 5): the graph queries behind them, the
 * pages themselves, links into them from race and measure pages, and that
 * downloaded pages stay self-contained. The fixtures put two races and a
 * measure in Fontana and a same-named candidate in Rialto, so cross-run
 * connections show and jurisdictions have a chance to mix (they mustn't).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { contextForMeasure, contextForRace } from "../src/context.ts";
import { financeForMeasure, financeForRace, raceConnections } from "../src/finance.ts";
import {
  contributorRef,
  keptApart,
  measureRef,
  nameKey,
  nearMisses,
  organizationRef,
  personRef,
  scopeKey,
  sideRef,
} from "../src/knowledge.ts";
import { runMeasure, runRace } from "../src/race.ts";
import { renderMeasure, renderRace } from "../src/render.ts";
import { JobRunner } from "../src/web/jobs.ts";
import { entitySlug } from "../src/web/kb.ts";
import { createApp } from "../src/web/server.ts";
import { openStores, type RunRecord } from "../src/web/store.ts";
import type {
  BallotCandidate,
  ContextWriter,
  FinanceResearcher,
  MeasureDossier,
  MeasureQuery,
  RaceDossier,
  RaceQuery,
  RawContribution,
  RawFact,
} from "../src/types.ts";
import { FakeResearch, listing, QUERY, raw, rawMeasure } from "./fakes.ts";

const HERALD = "https://www.fontanaherald.com/news/endorsements";
const BIO = "https://www.fontanaca.gov/council/bio";
const FILING = "https://public.netfile.com/pub2/filing/123.pdf";
const NEVER = "https://example.com/never-fetched";
const SOS = "https://cal-access.sos.ca.gov/committee/123";

const EVIL = `<script>alert(1)</script> Holdings`;

function fact(
  statement: string,
  source_url = HERALD,
  source_name = "Fontana Herald News",
): RawFact {
  return {
    statement,
    source_name,
    source_url,
    author: null,
    published: "2026-09-01",
    evidence_type: "reported",
  };
}

const section = (...facts: RawFact[]) => ({ facts, searched: [], gap_note: null });

function gift(contributor: string, amount: string, extra: Partial<RawContribution> = {}) {
  return {
    filer: "Committee",
    contributor,
    contributor_type: "organization",
    occupation: "",
    employer: "",
    amount,
    date: "09/14/2026",
    filing_period: "07/01/2026 - 09/19/2026",
    filing: "Form 460, Schedule A",
    source_name: "City of Fontana, NetFile",
    source_url: FILING,
    ...extra,
  } satisfies RawContribution;
}

const retired = { contributor_type: "individual", occupation: "Retired", employer: "" };

function researcher(table: Record<string, RawContribution[]>): FinanceResearcher {
  return {
    findContributions: (req) =>
      Promise.resolve({
        subjects: req.subjects.flatMap((s) => {
          const rows = table[s.role === "candidate" ? s.name : s.role];
          return rows
            ? [{
              id: s.id,
              committees: [],
              searched: [],
              gap_note: "",
              not_listed: "",
              totals: [],
              contributions: rows,
            }]
            : [];
        }),
        portal_gaps: [],
        retrieved_urls: [FILING],
        model: "fake",
      }),
  };
}

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

async function raceIn(
  q: RaceQuery,
  cands: BallotCandidate[],
  research: ConstructorParameters<typeof FakeResearch>[1],
  money: Record<string, RawContribution[]>,
): Promise<RaceDossier> {
  const d = await runRace(q, new FakeResearch(listing(cands), research), { candidates: cands });
  const { dossier: noted } = await contextForRace(d, notes);
  return (await financeForRace(noted, researcher(money))).dossier;
}

const WARREN: BallotCandidate = {
  name: "Acquanetta Warren",
  ballot_designation: "Mayor",
  incumbent: true,
};
const SIDA: BallotCandidate = { name: "Joz Sida", ballot_designation: null, incumbent: false };
const ANN: BallotCandidate = { name: "Ann Other", ballot_designation: null, incumbent: false };

const COUNCIL: RaceQuery = { ...QUERY, office: "City Council" };
const RIALTO: RaceQuery = { ...QUERY, city: "Rialto" };
const MEASURE: MeasureQuery = {
  label: "Measure X",
  jurisdiction: "City of Fontana",
  question: "",
  state: "CA",
  electionDate: "2026-11-03",
};

function mayor(): Promise<RaceDossier> {
  return raceIn(QUERY, [WARREN, SIDA], {
    "Acquanetta Warren": raw({
      sections: {
        background: section(
          fact(`Served on the council <img src=x onerror=alert(1)>.`, BIO, "City <b>bio</b>"),
        ),
        endorsements: section(fact("Endorsed by Inland Builders PAC.")),
      },
      retrieved_urls: [HERALD, BIO],
    }),
    "Joz Sida": raw({
      sections: {
        endorsements: section(fact("Inland Builders PAC endorsed Joz Sida.")),
        criticisms: section(fact("A claim nobody opened.", NEVER)),
      },
      retrieved_urls: [HERALD],
    }),
  }, {
    "Acquanetta Warren": [
      gift("Smith Development", "$500"),
      gift("Inland Builders PAC", "$1,000"),
      gift("Lee Roe", "$100", retired),
      gift(EVIL, "$5"),
      gift("Hidden Donor", "$9", { source_url: NEVER }),
    ],
    "Joz Sida": [gift("Smith Development LLC", "$750"), gift("Lee Roe", "$100", retired)],
  });
}

/** Sida again, but this run's research flagged a namesake: kept to this run. */
function council(): Promise<RaceDossier> {
  return raceIn(COUNCIL, [ANN, SIDA], {
    "Joz Sida": raw({ identity_note: "Another Joz Sida serves on a county board." }),
  }, { "Ann Other": [gift("Inland Builders PAC", "$300")] });
}

function rialto(): Promise<RaceDossier> {
  return raceIn(RIALTO, [WARREN], {}, {
    "Acquanetta Warren": [gift("Inland Builders PAC", "$2,000")],
  });
}

async function measure(): Promise<MeasureDossier> {
  const port = new FakeResearch(listing([]), {}, {
    "Measure X": rawMeasure({
      sections: { case_for: section(fact("Supported by Inland Builders PAC.")) },
      retrieved_urls: [HERALD],
    }),
  });
  const { dossier: noted } = await contextForMeasure(await runMeasure(MEASURE, port), notes);
  return (await financeForMeasure(
    noted,
    researcher({ support: [gift("Inland Builders PAC", "$5,000")] }),
  )).dossier;
}

function raceRun(id: string, race: RaceDossier, created: string, extra: Partial<RunRecord> = {}) {
  return {
    id,
    query: race.query,
    candidates: race.candidates.map((c) => c.candidate),
    candidate_source: null,
    choice_id: id,
    status: "done",
    created_at: created,
    updated_at: created,
    error: null,
    race,
    ...extra,
  } satisfies RunRecord;
}

function measureRun(id: string, m: MeasureDossier, created: string): RunRecord {
  return {
    id,
    query: { ...QUERY, city: MEASURE.jurisdiction, office: MEASURE.label },
    measure: MEASURE,
    measure_result: m,
    candidates: null,
    status: "done",
    created_at: created,
    updated_at: created,
    error: null,
    race: null,
  };
}

async function world() {
  const s = await openStores(await Deno.makeTempDir());
  const d = { mayor: await mayor(), council: await council(), rialto: await rialto() };
  await s.runs.save(raceRun("mayor-1", d.mayor, "2026-10-01T00:00:00Z"));
  await s.runs.save(raceRun("council-1", d.council, "2026-10-02T00:00:00Z"));
  await s.runs.save(raceRun("rialto-1", d.rialto, "2026-10-03T00:00:00Z"));
  const m = await measure();
  await s.runs.save(measureRun("m-1", m, "2026-10-04T00:00:00Z"));
  const kb = s.runs.knowledge;
  const get = (key: string) => {
    const e = kb.entity(key);
    assert(e, `no entity ${key}`);
    return e;
  };
  const app = createApp({
    store: s.runs,
    jobs: new JobRunner(s.runs, () => new FakeResearch(listing([]), {})),
    canResearch: false,
    basePath: "/bf",
  });
  const fetch = async (path: string, init?: RequestInit) => {
    const res = await app(new Request(`http://app.test${path}`, init));
    return { status: res.status, text: await res.text() };
  };
  return { s, kb, d, m, get, fetch };
}

const FONTANA = scopeKey("CA", "Fontana");

Deno.test("places and search stay in one jurisdiction, alphabetical", async () => {
  const { s, kb } = await world();
  assertEquals(kb.places().map((p) => p.place), ["Fontana, CA", "Rialto, CA"]);
  // "City of Fontana" (the measure) and "Fontana" (the races) are one place.
  assertEquals(scopeKey("CA", "City of Fontana"), FONTANA);
  const warrens = kb.search(FONTANA, "warren");
  assertEquals(warrens.map((e) => e.key), [personRef("CA", "Fontana", "Acquanetta Warren").key]);
  const all = kb.search(FONTANA, "").map((e) => e.name);
  assertEquals(all, [...all].sort((a, b) => nameKey(a).localeCompare(nameKey(b))));
  assert(all.includes("Supporters of Measure X (2026-11-03 election)"));
  assert(kb.search(FONTANA, "").every((e) => e.scope === FONTANA));
  // Punctuation and case don't matter; another place's entities never show.
  assertEquals(kb.search(FONTANA, "INLAND-builders").map((e) => e.name), ["Inland Builders PAC"]);
  assertEquals(kb.search(scopeKey("CA", "Rialto"), "joz"), []);
  s.db.close();
});

Deno.test("slugs are stable hashes of the key, so a rebuild keeps every address", async () => {
  const { s, kb, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  assertEquals(warren.slug, entitySlug(warren.key));
  kb.rebuild();
  assertEquals(kb.bySlug(warren.slug)?.key, warren.key);
  assertEquals(kb.bySlug("not-a-slug"), null);
  s.db.close();
});

Deno.test("peers are every other candidate and side in the same place, never elsewhere", async () => {
  const { s, kb, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const peers = kb.peersOf(warren)!;
  assertEquals(peers.map((p) => p.name), [
    "Ann Other",
    "Joz Sida",
    "Joz Sida",
    "Opponents of Measure X (2026-11-03 election)",
    "Supporters of Measure X (2026-11-03 election)",
  ]);
  assert(peers.every((p) => p.scope === FONTANA));
  // A donor or an organization isn't compared with anyone.
  assertEquals(kb.peersOf(get(organizationRef("CA", "Fontana", "Inland Builders PAC").key)), null);
  s.db.close();
});

Deno.test("cross-run connections match by identity and flag near misses, in one place only", async () => {
  const { s, kb, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const ann = get(personRef("CA", "Fontana", "Ann Other").key);
  const pair = kb.between(warren, ann);
  assertEquals(pair.shared.map((x) => x.entity.name), ["Inland Builders PAC"]);
  const [pac] = pair.shared;
  // Warren's ties come from the mayor's race (money and an endorsement), Ann's from council.
  assertEquals([...new Set(pac.a.map((t) => t.run_id))], ["mayor-1"]);
  assertEquals(pac.b.map((t) => t.run_id), ["council-1"]);
  // The measure's supporters share the PAC with Warren across runs too.
  const yes = get(sideRef(MEASURE, "support").key);
  assertEquals(kb.between(warren, yes).shared.map((x) => x.entity.name), ["Inland Builders PAC"]);
  // Same name, same PAC, other city: nothing is shared, whatever the names.
  const rialto = get(personRef("CA", "Rialto", "Acquanetta Warren").key);
  assertEquals(kb.between(warren, rialto), { shared: [], possible: [] });
  assert(kb.tiesOf(rialto.id).size > 0);
  s.db.close();
});

Deno.test("the graph and the page flag the same near misses, from one implementation", async () => {
  const { s, kb, d, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const sida = get(personRef("CA", "Fontana", "Joz Sida").key);
  const graph = kb.between(warren, sida).possible;
  const [page] = raceConnections(d.mayor, "mayor-1");
  assertEquals(graph, page.possible);
  assertEquals(
    graph.map((p) => [...p.a, ...p.b].join(" / ")),
    [
      "Smith Development / Smith Development LLC",
      "Lee Roe / Lee Roe",
    ].sort((a, b) => a.split(" ").reverse().join().localeCompare(b.split(" ").reverse().join())),
  );
  // With the run's id, page keys are the graph's keys, so entries can link.
  const lee = page.possible.find((p) => p.a[0] === "Lee Roe");
  assert(lee);
  const rowKey = contributorRef(
    "CA",
    "Fontana",
    { contributor: "Lee Roe", contributor_type: "individual", occupation: "Retired", employer: "" },
    "mayor-1|0|2",
  )!.key;
  assert(kb.entity(rowKey), "the page's row key is the graph's");
  assertEquals(nearMisses([{ key: "a", name: "X Co" }], [{ key: "a", name: "X Co" }]), []);
  s.db.close();
});

Deno.test("an entity page groups facts, shows every citation and run, and never sums money", async () => {
  const { s, fetch, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const { status, text } = await fetch(`/bf/entities/${warren.slug}`);
  assertEquals(status, 200);
  assertStringIncludes(text, "<h1>Acquanetta Warren</h1>");
  assertStringIncludes(text, "Person · Fontana, CA");
  assertStringIncludes(text, `<h4>Who they are</h4>`);
  assertStringIncludes(
    text,
    `href="/bf/races/mayor-1">Fontana Mayor · Nov 3, 2026</a>, researched`,
  );
  assertStringIncludes(text, "Nothing in finished research for:");
  assertStringIncludes(text, "Listed as the incumbent in");
  // Contributions: alphabetical by contributor, each as filed, no total anywhere.
  // Punctuation aside, as names compare everywhere: "<script>… Holdings" sorts as "script".
  const order = ["Inland Builders PAC", "Lee Roe", "&lt;script&gt;", "Smith Development"]
    .map((n) => text.indexOf(`">${n}`, text.indexOf("<h4>Received</h4>")));
  assert(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), String(order));
  assert(!/\btotal\b/i.test(text.replace(/totals only as the filing/g, "")));
  assert(!text.includes("Hidden Donor"), "an unverified contribution never enters the graph");
  // Cross-run view, collapsed, alphabetical by peer, with ties naming their runs.
  assertStringIncludes(
    text,
    `<details class="shared sec"><summary>Shared with others in Fontana, CA`,
  );
  const shared = text.slice(text.indexOf("Shared with others"));
  assert(shared.indexOf("Ann Other") < shared.indexOf("Supporters of Measure X"));
  assertStringIncludes(shared, "Possibly the same, kept separate");
  assert(!shared.includes("Rialto"), "another city's namesake is never compared");
  assert(!text.includes(get(personRef("CA", "Rialto", "Acquanetta Warren").key).slug));
  s.db.close();
});

Deno.test("entity pages escape research text and link only http(s) URLs", async () => {
  const { s, fetch, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const { text } = await fetch(`/bf/entities/${warren.slug}`);
  assert(!text.includes("<script>alert"), "no raw script");
  assert(!text.includes("<img src=x"), "no raw tag from a statement");
  assertStringIncludes(text, "&lt;img src=x onerror=alert(1)&gt;");
  assertStringIncludes(text, "City &lt;b&gt;bio&lt;/b&gt;");
  for (const [, href] of text.matchAll(/href="([^"]*)"/g)) {
    assert(href.startsWith("/bf/") || /^https?:\/\//.test(href) || href.startsWith("data:"), href);
  }
  const evil = get(organizationRef("CA", "Fontana", EVIL).key);
  const page = (await fetch(`/bf/entities/${evil.slug}`)).text;
  assertStringIncludes(page, "<h1>&lt;script&gt;alert(1)&lt;/script&gt; Holdings</h1>");
  assert(!page.includes("<script"));
  s.db.close();
});

Deno.test("unverified claims stay collapsed and apart, and never count as ties", async () => {
  const { s, kb, fetch, get } = await world();
  const sida = get(personRef("CA", "Fontana", "Joz Sida").key);
  const { text } = await fetch(`/bf/entities/${sida.slug}`);
  const at = text.indexOf("A claim nobody opened.");
  assert(at > text.indexOf(`<details class="unverified">`), "only inside the collapsed list");
  assertEquals(text.split("A claim nobody opened.").length, 2);
  for (const [, x] of kb.tiesOf(sida.id)) {
    assert(x.ties.every((t) => t.kind !== "named" || !t.statement.includes("nobody opened")));
  }
  s.db.close();
});

Deno.test("an entity kept to one run, or to one filing row, says so", async () => {
  const { s, fetch, get } = await world();
  const ambiguous = get(personRef("CA", "Fontana", "Joz Sida", "council-1").key);
  const one = (await fetch(`/bf/entities/${ambiguous.slug}`)).text;
  assertStringIncludes(one, "Kept to one run.");
  assertStringIncludes(one, "council-1");
  assert(!one.includes("mayor-1"), "nothing from another run is joined to it");
  const lee = get(
    contributorRef(
      "CA",
      "Fontana",
      {
        contributor: "Lee Roe",
        contributor_type: "individual",
        occupation: "Retired",
        employer: "",
      },
      "mayor-1|0|2",
    )!.key,
  );
  const row = (await fetch(`/bf/entities/${lee.slug}`)).text;
  assertStringIncludes(row, "Kept to one contribution.");
  assertStringIncludes(row, "Individual contributor");
  assertStringIncludes(row, "never joined to this page or suggested here");
  s.db.close();
});

Deno.test("a rerun marks older facts; an entity only from a run no longer done disappears", async () => {
  const { s, d, fetch, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const newcomer: BallotCandidate = {
    name: "New Person",
    ballot_designation: null,
    incumbent: false,
  };
  const again = await raceIn(QUERY, [WARREN, newcomer], {}, {});
  await s.runs.save(
    raceRun("mayor-2", again, "2026-10-10T00:00:00Z", { choice_id: "mayor-1" }),
  );
  const text = (await fetch(`/bf/entities/${warren.slug}`)).text;
  assertStringIncludes(text, `<a href="/bf/races/mayor-2">researched again since</a>`);
  const slug = get(personRef("CA", "Fontana", "New Person").key).slug;
  assertEquals((await fetch(`/bf/entities/${slug}`)).status, 200);
  await s.runs.save(raceRun("mayor-2", again, "2026-10-10T00:00:00Z", {
    choice_id: "mayor-1",
    status: "failed",
  }));
  assertEquals((await fetch(`/bf/entities/${slug}`)).status, 404);
  assert(!(await fetch(`/bf/entities/${warren.slug}`)).text.includes("researched again since"));
  void d;
  s.db.close();
});

Deno.test("the search page lists places and results alphabetically, GET only", async () => {
  const { s, fetch } = await world();
  const home = await fetch("/bf/entities");
  assertStringIncludes(home.text, `<option value="ca|fontana">Fontana, CA</option>`);
  assertStringIncludes(home.text, `action="/bf/entities"`);
  const res = (await fetch(`/bf/entities?place=${encodeURIComponent(FONTANA)}&q=sida`)).text;
  assertStringIncludes(res, "kept to one run: Fontana City Council · Nov 3, 2026, researched");
  assertEquals(res.split(`class="who-name"`).length - 1, 2);
  const all = (await fetch(`/bf/entities?place=${encodeURIComponent(FONTANA)}`)).text;
  const names = [...all.matchAll(/class="who-name" href="[^"]+">([^<]+) </g)]
    .map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  assert(names.length > 10);
  assertEquals(names, [...names].sort((a, b) => nameKey(a).localeCompare(nameKey(b))));
  const xss = (await fetch(`/bf/entities?place=${FONTANA}&q=${encodeURIComponent("<b>x")}`))
    .text;
  assert(!xss.includes("<b>x"));
  // An unknown place searches nothing rather than everything.
  const bogus = (await fetch(`/bf/entities?place=zz%7Cnowhere&q=a`)).text;
  assert(!bogus.includes(`class="who-name"`));
  const posted = await fetch("/bf/entities", {
    method: "POST",
    headers: { origin: "http://app.test" },
  });
  assertEquals(posted.status, 405);
  assertEquals((await fetch("/bf/entities/0123456789abcdef01234567")).status, 404);
  s.db.close();
});

Deno.test("race and measure pages link names into the app; downloads never do", async () => {
  const { s, d, m, fetch, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const pac = get(organizationRef("CA", "Fontana", "Inland Builders PAC").key);
  const page = (await fetch("/bf/races/mayor-1")).text;
  assertStringIncludes(
    page,
    `<h2><a href="/bf/entities/${warren.slug}">Acquanetta Warren</a></h2>`,
  );
  assertStringIncludes(page, `<span class="named"><a href="/bf/entities/${pac.slug}">`);
  assertStringIncludes(page, `<li><strong><a href="/bf/entities/${pac.slug}">Inland Builders PAC`);
  const mp = (await fetch("/bf/races/m-1")).text;
  const yes = get(sideRef(MEASURE, "support").key);
  assertStringIncludes(mp, `<a href="/bf/entities/${yes.slug}">supporters</a>`);
  assert(get(measureRef(MEASURE).key));

  for (const path of ["/bf/races/mayor-1/download", "/bf/races/m-1/download"]) {
    const file = (await fetch(path)).text;
    assert(!file.includes("/entities"), path);
    assert(!/href="\//.test(file), `${path} links into the app`);
  }
  for (const file of [renderRace(d.mayor), renderMeasure(m)]) {
    assert(!file.includes("/entities"));
    assert(!/href="\//.test(file));
  }
  s.db.close();
});

Deno.test("a page links only to entities its own run holds", async () => {
  const { s, d, fetch } = await world();
  // Same race, unfinished: the entities exist from mayor-1, but this run holds none.
  await s.runs.save(raceRun("mayor-3", d.mayor, "2026-10-11T00:00:00Z", { status: "running" }));
  const page = (await fetch("/bf/races/mayor-3")).text;
  assert(!page.includes("/entities/"));
  s.db.close();
});

Deno.test("a name that reads like a key marker is never taken for one", () => {
  assertEquals(keptApart(organizationRef("CA", "Fontana", "Run for Something").key), null);
  assertEquals(keptApart(organizationRef("CA", "Fontana", "Donor Network of CA").key), null);
  assertEquals(keptApart(personRef("CA", "Fontana", "Run Lee").key), null);
  assertEquals(keptApart(personRef("CA", "Fontana", "Run Lee", "r-1").key), "run");
  const work = { contributor: "Donor Run", contributor_type: "individual" as const };
  assertEquals(
    keptApart(
      contributorRef(
        "CA",
        "Fontana",
        { ...work, occupation: "Engineer", employer: "Run Club" },
        "x",
      )!.key,
    ),
    "work",
  );
  assertEquals(
    keptApart(
      contributorRef("CA", "Fontana", { ...work, occupation: "Retired", employer: null }, "x")!.key,
    ),
    "row",
  );
});

Deno.test("same-labeled measures of different elections are told apart by name", () => {
  const later = { ...MEASURE, electionDate: "2028-11-07" };
  assert(sideRef(MEASURE, "support").name !== sideRef(later, "support").name);
  assertStringIncludes(measureRef(later).name, "2028-11-07");
});

Deno.test("every peer gets a block in alphabetical order, whatever it shares", async () => {
  const { s, fetch, get } = await world();
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  const text = (await fetch(`/bf/entities/${warren.slug}`)).text;
  const shared = text.slice(
    text.indexOf("Shared with others"),
    text.indexOf("Where this comes from"),
  );
  const heads = [...shared.matchAll(/<h5><a [^>]+>([^<]+)<\/a>/g)].map((m) => m[1]);
  assertEquals(heads, [
    "Ann Other",
    "Joz Sida",
    "Joz Sida",
    "Opponents of Measure X (2026-11-03 election)",
    "Supporters of Measure X (2026-11-03 election)",
  ]);
  assertStringIncludes(shared, "No shared contributors or endorsers found.");
  s.db.close();
});

Deno.test("a search of punctuation alone lists the place, not a quoted non-match", async () => {
  const { s, fetch } = await world();
  const text = (await fetch(`/bf/entities?place=${encodeURIComponent(FONTANA)}&q=!!!`)).text;
  assertStringIncludes(text, "Everything in Fontana, CA");
  assert(!text.includes("containing"));
  s.db.close();
});

Deno.test("a corrupt run row doesn't break entity pages", async () => {
  const { s, fetch, get } = await world();
  s.db.run(
    "INSERT INTO runs (id, created_at, status, body) VALUES ('bad-1', '2026-10-20', 'done', '{nope')",
  );
  const warren = get(personRef("CA", "Fontana", "Acquanetta Warren").key);
  assertEquals((await fetch(`/bf/entities/${warren.slug}`)).status, 200);
  s.db.close();
});
