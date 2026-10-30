/**
 * Scoring half of an answer-key check: how often the research's verified facts
 * are right (precision), and how much of what a person knows about a past race
 * it finds (recall). The judging is a person's: this draws the sample, reads
 * back their judgments, and matches their key. It never judges a fact itself,
 * and no key ships with it.
 *
 *   deno task answer-key sample <run.json> [--n 25] [--seed 1] [--out out/sheet.json]
 *       draws verified facts at random into a review sheet to fill in
 *   deno task answer-key precision <sheet.json>
 *       scores a filled sheet
 *   deno task answer-key recall <run.json> <key.json>
 *       scores a run against a key the owner wrote
 *
 * Runs are the CLI's output or the app's /races/:id.json. No model or network calls.
 */

import { parseArgs } from "@std/cli/parse-args";
import { normalizeUrl } from "./dossier.ts";
import { raceOf, SAME_FACT, sectionsOf, similarity, urlsOf } from "./stability.ts";
import type { Fact, RaceDossier, RaceQuery } from "./types.ts";

/**
 * What a reviewer says about one sampled fact, after opening its page:
 * - supported: the page says it, about this person;
 * - not_supported: the page doesn't say it, or says something else;
 * - wrong_person: the page is about someone else;
 * - unsure: can't tell (page gone, paywalled); left out of the score.
 * "" until judged.
 */
export const JUDGMENTS = ["supported", "not_supported", "wrong_person", "unsure"] as const;
export type Judgment = typeof JUDGMENTS[number];

export interface SheetItem {
  id: string;
  candidate: string;
  section: string;
  statement: string;
  source_name: string;
  source_url: string;
  quote: string | null;
  /** The run's quote check, so precision can be read by level. null on older runs. */
  check_level: string | null;
  judgment: Judgment | "";
  note: string;
}

export interface ReviewSheet {
  query: RaceQuery;
  generated_at: string;
  seed: number;
  /** Verified facts the sample was drawn from, each fact once. */
  drawn_from: number;
  instructions: string;
  items: SheetItem[];
}

const INSTRUCTIONS = `Open each source_url and set judgment to one of: ${JUDGMENTS.join(", ")}. ` +
  "supported: the page says the statement, about this candidate. not_supported: it doesn't, " +
  "or says something else. wrong_person: the page is about someone else. unsure: can't tell " +
  "(left out of the score). Judge the statement against the page, not whether you agree with it.";

/** A small seeded generator (mulberry32), so a sample can be drawn again the same. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Located {
  candidate: string;
  section: string;
  fact: Fact;
}

/** Every verified fact of every finished candidate, a fact under a voter's issue and its section once. */
export function verifiedFacts(race: RaceDossier): Located[] {
  const out: Located[] = [];
  for (const d of race.candidates) {
    if (d.status !== "ok") continue;
    const seen = new Set<string>();
    for (const s of sectionsOf(d)) {
      for (const f of s.facts) {
        const k = `${f.statement}\n${f.source_url}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ candidate: d.candidate.name, section: s.title, fact: f });
      }
    }
  }
  return out;
}

/**
 * Draws n verified facts uniformly at random (all of them when there are
 * fewer), listed in ballot and template order so the sheet reads like the page.
 */
export function sampleSheet(race: RaceDossier, n: number, seed: number, now: Date): ReviewSheet {
  const all = verifiedFacts(race);
  const idx = all.map((_, i) => i);
  const next = rng(seed);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const picked = idx.slice(0, n).sort((a, b) => a - b);
  return {
    query: race.query,
    generated_at: now.toISOString(),
    seed,
    drawn_from: all.length,
    instructions: INSTRUCTIONS,
    items: picked.map((i, k) => {
      const { candidate, section, fact } = all[i];
      return {
        id: `f${k + 1}`,
        candidate,
        section,
        statement: fact.statement,
        source_name: fact.source_name,
        source_url: fact.source_url,
        quote: fact.quote || null,
        check_level: fact.check?.level ?? null,
        judgment: "",
        note: "",
      };
    }),
  };
}

export interface Rate {
  /** Counted toward the rate. */
  of: number;
  hits: number;
  /** null when nothing was counted. */
  rate: number | null;
  /** A 95% Wilson interval: a small sample says little, and this says how little. */
  low: number | null;
  high: number | null;
}

export function rate(hits: number, of: number): Rate {
  if (!of) return { of, hits, rate: null, low: null, high: null };
  const z = 1.96, p = hits / of;
  const d = 1 + (z * z) / of;
  const mid = (p + (z * z) / (2 * of)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / of + (z * z) / (4 * of * of))) / d;
  return {
    of,
    hits,
    rate: p,
    low: Math.max(0, mid - half),
    high: Math.min(1, mid + half),
  };
}

export interface PrecisionReport {
  query: RaceQuery;
  items: number;
  counts: Record<Judgment | "unjudged", number>;
  /** supported over supported, not_supported, and wrong_person. */
  precision: Rate;
  /** The same, by the run's quote-check level ("none" for older runs). */
  by_level: Record<string, Rate>;
  /** Items whose judgment isn't one of JUDGMENTS or blank: fix the sheet and score again. */
  invalid: string[];
}

export function scorePrecision(sheet: ReviewSheet): PrecisionReport {
  const counts = { supported: 0, not_supported: 0, wrong_person: 0, unsure: 0, unjudged: 0 };
  const invalid: string[] = [];
  const levels = new Map<string, { hits: number; of: number }>();
  for (const it of sheet.items) {
    const j = String(it.judgment ?? "").trim();
    if (j === "") counts.unjudged++;
    else if ((JUDGMENTS as readonly string[]).includes(j)) counts[j as Judgment]++;
    else {
      invalid.push(it.id);
      continue;
    }
    if (j === "" || j === "unsure") continue;
    const lv = it.check_level ?? "none";
    const l = levels.get(lv) ?? { hits: 0, of: 0 };
    l.of++;
    if (j === "supported") l.hits++;
    levels.set(lv, l);
  }
  const judged = counts.supported + counts.not_supported + counts.wrong_person;
  return {
    query: sheet.query,
    items: sheet.items.length,
    counts,
    precision: rate(counts.supported, judged),
    by_level: Object.fromEntries(
      [...levels].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, rate(v.hits, v.of)]),
    ),
    invalid,
  };
}

/**
 * The owner's list of what a good dossier on a past race would include. Each
 * item names a candidate and, optionally, a section (its id or title) and
 * pages that document it.
 */
export interface AnswerKey {
  query?: Partial<RaceQuery>;
  items: KeyItem[];
}

export interface KeyItem {
  candidate: string;
  /** A template section's id or title, or a voter's issue in their words; any section when absent. */
  section?: string;
  statement: string;
  urls?: string[];
}

export interface KeyResult {
  item: KeyItem;
  /** How it was found: a fact citing one of its pages, or a fact worded alike. */
  found: "url" | "wording" | null;
  /** The fact it matched, for a person to check the match. */
  fact: { section: string; statement: string; source_url: string } | null;
  /**
   * Set when the item can't be scored: the key names a candidate or section
   * the run doesn't have, or that candidate's research failed. Such items are
   * left out of recall, as a failed run is left out of the stability overlap.
   */
  problem: string | null;
}

export interface RecallReport {
  query: RaceQuery;
  /** Set when the key's race doesn't match the run's. */
  mismatch: string | null;
  recall: Rate;
  by_candidate: { name: string; recall: Rate }[];
  results: KeyResult[];
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Matches each key item to the run's verified facts: first by a page the key
 * gives, then by wording (SAME_FACT). Only verified facts count, since only
 * they are shown as findings. A matched page shows the run found that source,
 * not that it read it fairly; the report lists each match to check.
 */
export function scoreRecall(race: RaceDossier, key: AnswerKey): RecallReport {
  const bad = !Array.isArray(key?.items) ||
    key.items.some((i) =>
      typeof i?.candidate !== "string" || typeof i.statement !== "string" ||
      (i.section !== undefined && typeof i.section !== "string") ||
      (i.urls !== undefined &&
        !(Array.isArray(i.urls) && i.urls.every((u) => typeof u === "string")))
    );
  if (bad) throw new Error("a key needs items, each with a candidate and a statement (see --help)");
  const q = race.query;
  const kq = key.query ?? {};
  const differs = (["city", "state", "office", "electionDate"] as const).filter((f) =>
    kq[f] !== undefined && norm(String(kq[f])) !== norm(q[f])
  );
  // Each fact answers one key item at most, so two items can't both count one finding.
  const used = new Set<Fact>();
  const results = key.items.map((item): KeyResult => {
    const d = race.candidates.find((c) => norm(c.candidate.name) === norm(item.candidate));
    const none = (problem: string | null): KeyResult => ({
      item,
      found: null,
      fact: null,
      problem,
    });
    if (!d) return none(`no candidate named "${item.candidate}" in this run`);
    if (d.status !== "ok") return none(`research on ${d.candidate.name} failed in this run`);
    let sections = sectionsOf(d);
    if (item.section) {
      const want = norm(item.section);
      sections = sections.filter((s) =>
        norm(s.key) === want || norm(s.title) === want || norm(s.key) === `issue:${want}`
      );
      if (!sections.length) return none(`no section "${item.section}"`);
    }
    const facts = sections.flatMap((s) =>
      s.facts.filter((f) => !used.has(f)).map((f) => ({ s, f }))
    );
    const pages = new Set(
      (item.urls ?? []).map((u) => normalizeUrl(u)).filter((u): u is string => !!u),
    );
    const byUrl = facts.find(({ f }) => urlsOf(f).some((u) => pages.has(u)));
    const best = facts
      .map(({ s, f }) => ({ s, f, sim: similarity(item.statement, f.statement) }))
      .filter((x) => x.sim >= SAME_FACT)
      .sort((a, b) => b.sim - a.sim)[0];
    const hit = byUrl ?? best;
    if (!hit) return none(null);
    used.add(hit.f);
    return {
      item,
      found: byUrl ? "url" : "wording",
      fact: { section: hit.s.title, statement: hit.f.statement, source_url: hit.f.source_url },
      problem: null,
    };
  });
  // One line per candidate however the key spells them, named as the run does.
  const names = new Map<string, string>();
  for (const i of key.items) {
    const run = race.candidates.find((c) => norm(c.candidate.name) === norm(i.candidate));
    if (!names.has(norm(i.candidate))) {
      names.set(norm(i.candidate), run?.candidate.name ?? i.candidate);
    }
  }
  const rateOf = (rs: KeyResult[]) => {
    const scored = rs.filter((r) => !r.problem);
    return rate(scored.filter((r) => r.found).length, scored.length);
  };
  return {
    query: q,
    mismatch: differs.length
      ? `the key is for a different race (${differs.join(", ")} differ${
        differs.length === 1 ? "s" : ""
      })`
      : null,
    recall: rateOf(results),
    by_candidate: [...names].map(([k, name]) => ({
      name,
      recall: rateOf(results.filter((r) => norm(r.item.candidate) === k)),
    })),
    results,
  };
}

const pct = (x: number | null) => x === null ? "n/a" : `${Math.round(x * 100)}%`;
const rateText = (r: Rate) =>
  r.rate === null
    ? "nothing to score"
    : `${r.hits} of ${r.of}, ${pct(r.rate)} (95% interval ${pct(r.low)} to ${pct(r.high)})`;

export function formatPrecision(r: PrecisionReport): string {
  const c = r.counts;
  return [
    `Precision: ${r.query.office}, ${r.query.city}, ${r.query.electionDate}: ${r.items} sampled`,
    `  supported ${c.supported}, not supported ${c.not_supported}, wrong person ${c.wrong_person}, unsure ${c.unsure}, not judged ${c.unjudged}`,
    `  precision: ${rateText(r.precision)}`,
    ...Object.entries(r.by_level).map(([lv, x]) => `    quote check ${lv}: ${rateText(x)}`),
    ...(r.invalid.length ? [`  not a judgment, left out: ${r.invalid.join(", ")}`] : []),
  ].join("\n");
}

export function formatRecall(r: RecallReport): string {
  const out = [
    `Recall: ${r.query.office}, ${r.query.city}, ${r.query.electionDate}: ${r.results.length} key items`,
  ];
  if (r.mismatch) out.push(`  Warning: ${r.mismatch}`);
  out.push(`  recall: ${rateText(r.recall)}`);
  for (const c of r.by_candidate) out.push(`    ${c.name}: ${rateText(c.recall)}`);
  out.push("");
  for (const x of r.results) {
    const head = `${x.item.candidate}${
      x.item.section ? `, ${x.item.section}` : ""
    }: ${x.item.statement}`;
    if (x.found) {
      out.push(`  found (${x.found}): ${head}`, `      ${x.fact!.section}: ${x.fact!.statement}`);
    } else if (x.problem) out.push(`  not scored: ${head} (${x.problem})`);
    else out.push(`  missed: ${head}`);
  }
  return out.join("\n");
}

const USAGE = `Usage:
  deno task answer-key sample <run.json> [--n 25] [--seed 1] [--out out/sheet.json]
  deno task answer-key precision <sheet.json> [--json]
  deno task answer-key recall <run.json> <key.json> [--json]

A key is JSON: {"query": {"city": ..., "office": ..., "electionDate": ...},
"items": [{"candidate": "Name", "section": "criticisms", "statement": "...", "urls": ["..."]}]}.
section and urls are optional. No model or network calls.`;

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ["n", "seed", "out"],
    boolean: ["help", "json"],
    default: { n: "25", seed: "1" },
  });
  const [cmd, ...files] = args._.map(String);
  if (args.help || !cmd) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  const read = async (f: string) => JSON.parse(await Deno.readTextFile(f));
  if (cmd === "sample" && files.length === 1) {
    const n = Number(args.n), seed = Number(args.seed);
    if (!Number.isInteger(n) || n < 1 || !Number.isInteger(seed)) {
      console.error("--n must be a positive whole number and --seed a whole number");
      return 2;
    }
    const sheet = sampleSheet(raceOf(await read(files[0])), n, seed, new Date());
    const text = JSON.stringify(sheet, null, 2);
    if (args.out) {
      await Deno.writeTextFile(args.out, text);
      console.error(`Wrote ${sheet.items.length} of ${sheet.drawn_from} facts to ${args.out}`);
    } else console.log(text);
    return 0;
  }
  if (cmd === "precision" && files.length === 1) {
    const r = scorePrecision(await read(files[0]) as ReviewSheet);
    console.log(args.json ? JSON.stringify(r, null, 2) : formatPrecision(r));
    return 0;
  }
  if (cmd === "recall" && files.length === 2) {
    const r = scoreRecall(raceOf(await read(files[0])), await read(files[1]) as AnswerKey);
    console.log(args.json ? JSON.stringify(r, null, 2) : formatRecall(r));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) Deno.exit(await main());
