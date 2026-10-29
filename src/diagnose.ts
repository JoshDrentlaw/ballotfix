/**
 * Why shared connections come up empty: a read-only report over saved runs.
 * No model or network calls, and nothing is written.
 *
 *   deno task diagnose                      every ballot in data/ballotfix.db
 *   deno task diagnose --ballot <id>        one ballot
 *   deno task diagnose --json               the same, as JSON
 *   deno task diagnose --data <dir>         another data directory
 *
 * For each ballot it reports, per item, whether the context and finance steps
 * ran and what they kept, and then every name that comes up for two or more
 * subjects on the ballot, with how each subject holds it: as a tie the
 * connections views can match, or not, and why not. The ties are built by the
 * same code the pages use (`raceParties`, `measureParties`), so a name shown
 * as matched here is one the pages can match.
 */

import { parseArgs } from "@std/cli/parse-args";
import { DatabaseSync } from "node:sqlite";
import { exclusions, findNames } from "./context.ts";
import { measureParties, NOTHING_OPENED, type Party, raceParties } from "./finance.ts";
import { contributorRef, keptApart, looseKey, nameKey, scopeKey } from "./knowledge.ts";
import { measuresOf } from "./dossier.ts";
import type { BallotRecord, RunRecord } from "./web/store.ts";
import type { ContextResult, FinanceResult, FinanceSubjectResult, SectionResult } from "./types.ts";

/** One subject a connection can be about: a candidate, or one side of a measure. */
export interface SubjectReport {
  label: string;
  finance: {
    /** False when the run has no finance result, or no entry for this subject. */
    found: boolean;
    kept: number;
    organizations: number;
    individuals: number;
    /** Individuals whose occupation and employer can tell same-named people apart. */
    identifying: number;
    untyped: number;
    unverified: number;
    dropped: number;
    over_share: number;
    opened_nothing: boolean;
    gap_note: string | null;
  };
  /** Names picked out of this subject's endorsements (or its side's case), as findNames does. */
  support_names: number;
  ties: { contribution: number; named: number };
}

export interface ItemReport {
  key: string;
  label: string;
  kind: "race" | "measure" | "retention";
  run_id: string | null;
  status: string;
  place: string;
  scope: string;
  context: StepReport & {
    found: number;
    verified_notes: number;
    unverified_notes: number;
    not_described: number;
    not_needed: number;
    over_cap: number;
  };
  finance: StepReport & { portal_gaps: string[] };
  subjects: SubjectReport[];
  /** Pairs within this item that share something: what its own page shows. */
  shared_within: number;
}

interface StepReport {
  state: "ran" | "failed" | "not run" | "nothing to do";
  error: string | null;
}

/** How one subject holds a recurring name. */
export interface Holding {
  item: string;
  subject: string;
  scope: string;
  /** The entity key when it is a tie; null when the name is there but not tied. */
  key: string | null;
  how: string;
}

/** A name (by loose key) that comes up for two or more subjects on one ballot. */
export interface Recurring {
  name: string;
  /** "connected": one entity key held by subjects of two or more items. */
  verdict:
    | "connected"
    | "shared within one item"
    | "same scope, different entity"
    | "different scope"
    | "not tied";
  holdings: Holding[];
}

export interface BallotReport {
  ballot: string;
  created_at: string | null;
  items: ItemReport[];
  /** Distinct scopes, with the items in each: only items in one scope are compared. */
  scopes: Record<string, string[]>;
  recurring: Recurring[];
  totals: {
    subjects: number;
    subjects_with_money: number;
    contributions_kept: number;
    verified_notes: number;
    ties: number;
    shared_within_items: number;
    connected_across_items: number;
    blocked_by_scope: number;
    blocked_by_entity_rule: number;
    not_tied: number;
  };
}

interface Subject {
  item: ItemReport;
  label: string;
  party: Party | null;
  support: SectionResult[];
  exclude: ReturnType<typeof exclusions>;
  context: ContextResult | undefined;
}

const isMeasure = (r: RunRecord) => Boolean(r.measure);

function kindOf(r: RunRecord): ItemReport["kind"] {
  if (isMeasure(r)) return "measure";
  return r.candidate_source?.contest_kind === "retention" ? "retention" : "race";
}

function step(
  done: boolean,
  result: { error?: string } | undefined,
  hasWork: boolean,
): StepReport {
  if (!done) return { state: "not run", error: null };
  if (!result) return { state: hasWork ? "not run" : "nothing to do", error: null };
  return result.error ? { state: "failed", error: result.error } : { state: "ran", error: null };
}

function moneyOf(s: FinanceSubjectResult | undefined): SubjectReport["finance"] {
  const kept = s?.contributions ?? [];
  const individuals = kept.filter((c) => c.contributor_type === "individual");
  return {
    found: Boolean(s),
    kept: kept.length,
    organizations: kept.filter((c) => c.contributor_type === "organization").length,
    individuals: individuals.length,
    // contributorRef's own rule: an individual is matchable only when kept apart by "work".
    identifying:
      individuals.filter((c) => keptApart(contributorRef("", "", c, "x")!.key) === "work")
        .length,
    untyped: kept.filter((c) => c.contributor_type === "unknown").length,
    unverified: s?.unverified.length ?? 0,
    dropped: s?.dropped ?? 0,
    over_share: s?.left_out.length ?? 0,
    opened_nothing: s?.gap_note === NOTHING_OPENED,
    gap_note: s?.gap_note ?? null,
  };
}

function contextOf(c: ContextResult | undefined) {
  return {
    found: c
      ? c.notes.length + c.not_looked_up.length + c.not_described.length +
        (c.not_needed?.length ?? 0)
      : 0,
    verified_notes: c?.notes.filter((n) => n.verified).length ?? 0,
    unverified_notes: c?.notes.filter((n) => !n.verified).length ?? 0,
    not_described: c?.not_described.length ?? 0,
    not_needed: c?.not_needed?.length ?? 0,
    over_cap: c && !c.error ? c.not_looked_up.length : 0,
  };
}

function financeSubjects(f: FinanceResult | undefined) {
  return f?.subjects ?? [];
}

/** The item and its subjects, from the run the ballot points at. */
function itemOf(key: string, label: string, run: RunRecord | undefined): {
  item: ItemReport;
  subjects: Subject[];
} {
  const base = {
    key,
    label,
    run_id: run?.id ?? null,
    status: run?.status ?? "missing",
  };
  if (!run) {
    return {
      item: {
        ...base,
        kind: "race",
        place: "",
        scope: "",
        context: { ...step(false, undefined, false), ...contextOf(undefined) },
        finance: { ...step(false, undefined, false), portal_gaps: [] },
        subjects: [],
        shared_within: 0,
      },
      subjects: [],
    };
  }
  const done = run.status === "done";
  const m = run.measure_result ?? null;
  const race = run.race;
  const state = m ? m.query.state : run.query.state;
  const jurisdiction = m ? m.query.jurisdiction : run.query.city;
  const context = m ? m.context : race?.context;
  const finance = m ? m.finance : race?.finance;
  const item: ItemReport = {
    ...base,
    kind: kindOf(run),
    place: [jurisdiction, state].filter(Boolean).join(", "),
    scope: scopeKey(state, jurisdiction),
    context: { ...step(done, context, true), ...contextOf(context) },
    finance: {
      ...step(done, finance, true),
      portal_gaps: (finance?.portal_gaps ?? []).map((g) => `${g.portal}: ${g.problem}`),
    },
    subjects: [],
    shared_within: 0,
  };

  const subjects: Subject[] = [];
  if (m) {
    const parties = done ? measureParties(m, run.id) : [];
    const ex = exclusions(m.query.label ? [m.query.label] : [], [m.query.jurisdiction]);
    (["support", "oppose"] as const).forEach((side, n) => {
      subjects.push({
        item,
        label: side === "support" ? "Supporters" : "Opponents",
        party: parties[n] ?? null,
        support: m.status === "ok"
          ? [m.sections[side === "support" ? "case_for" : "case_against"]]
          : [],
        exclude: ex,
        context,
      });
      const money = financeSubjects(finance).find((s) => s.side === side);
      item.subjects.push(subjectReport(subjects.at(-1)!, money));
    });
  } else if (race) {
    const parties = done ? raceParties(race, run.id) : [];
    const ex = exclusions(race.candidates.map((c) => c.candidate.name), [race.query.city]);
    let p = 0;
    race.candidates.forEach((c, i) => {
      const party = c.status === "pending" ? null : parties[p++] ?? null;
      subjects.push({
        item,
        label: c.candidate.name,
        party,
        support: c.status === "ok" ? [c.sections.endorsements] : [],
        exclude: ex,
        context,
      });
      const money = financeSubjects(finance).find((s) => s.candidate === i);
      item.subjects.push(subjectReport(subjects.at(-1)!, money));
    });
  }
  // What the item's own page shows: pairs within it that share an entity.
  const ps = subjects.flatMap((s) => s.party ? [s.party] : []);
  for (let a = 0; a < ps.length; a++) {
    for (let b = a + 1; b < ps.length; b++) {
      if ([...ps[a].ties.keys()].some((k) => ps[b].ties.has(k))) item.shared_within++;
    }
  }
  return { item, subjects };
}

function supportNames(s: Subject): string[] {
  return [
    ...new Set(
      s.support.flatMap((r) => r?.facts ?? []).flatMap((f) => findNames(f.statement, s.exclude)),
    ),
  ];
}

function subjectReport(s: Subject, money: FinanceSubjectResult | undefined): SubjectReport {
  const ties = [...(s.party?.ties.values() ?? [])].flatMap((t) => t.ties);
  return {
    label: s.label,
    finance: moneyOf(money),
    support_names: supportNames(s).length,
    ties: {
      contribution: ties.filter((t) => t.kind === "contribution").length,
      named: ties.filter((t) => t.kind === "named").length,
    },
  };
}

/** Why a name found in a subject's support facts isn't a tie, read off the context result. */
function whyUntied(name: string, c: ContextResult | undefined, status: string): string {
  if (status !== "done") return `run is ${status}`;
  if (!c) return "context step didn't run";
  const k = nameKey(name);
  const has = (xs: readonly string[] | undefined) => (xs ?? []).some((x) => nameKey(x) === k);
  const note = c.notes.find((n) => nameKey(n.name) === k);
  if (note && !note.verified) return "note's source wasn't retrieved (unverified)";
  if (note) return "verified note didn't attach to the fact's wording";
  if (has(c.not_needed)) return "model said no note needed";
  if (has(c.not_described)) return "looked up, no sourced note";
  if (has(c.not_looked_up)) return c.error ? "context step failed" : "over the name cap";
  return "not picked up as a name by the context step";
}

function recurringNames(subjects: Subject[]): Recurring[] {
  // loose key -> subject index -> holdings
  const by = new Map<string, { name: string; holdings: Map<number, Holding[]> }>();
  const add = (loose: string, name: string, i: number, h: Holding) => {
    if (!loose) return;
    const got = by.get(loose) ?? { name, holdings: new Map() };
    got.holdings.set(i, [...(got.holdings.get(i) ?? []), h]);
    by.set(loose, got);
  };
  subjects.forEach((s, i) => {
    const at = { item: s.item.label, subject: s.label, scope: s.item.scope };
    const tied = new Set<string>();
    for (const { ref, ties } of s.party?.ties.values() ?? []) {
      const kinds = [...new Set(ties.map((t) => t.kind === "contribution" ? "gave" : "endorses"))];
      add(looseKey(ref.name), ref.name, i, { ...at, key: ref.key, how: kinds.join(" + ") });
      tied.add(looseKey(ref.name));
    }
    for (const name of s.party?.untyped ?? []) {
      add(looseKey(name), name, i, {
        ...at,
        key: null,
        how: "gave, but the filing doesn't say individual or organization",
      });
    }
    for (const name of supportNames(s)) {
      const k = looseKey(name);
      if (tied.has(k)) continue;
      add(k, name, i, {
        ...at,
        key: null,
        how: `named in support facts, no tie: ${whyUntied(name, s.context, s.item.status)}`,
      });
    }
  });

  const out: Recurring[] = [];
  for (const { name, holdings } of by.values()) {
    if (holdings.size < 2) continue;
    const all = [...holdings.values()].flat();
    // Connected: one key held by subjects of two or more different items.
    const items = new Map<string, Set<string>>();
    const holders = new Map<string, Set<number>>();
    for (const [i, hs] of holdings) {
      for (const h of hs) {
        if (!h.key) continue;
        items.set(h.key, (items.get(h.key) ?? new Set()).add(h.item));
        holders.set(h.key, (holders.get(h.key) ?? new Set()).add(i));
      }
    }
    const keyed = all.filter((h) => h.key);
    const subjectsKeyed = new Set(
      [...holdings].filter(([, hs]) => hs.some((h) => h.key)).map(([i]) => i),
    );
    let verdict: Recurring["verdict"];
    if ([...items.values()].some((s) => s.size > 1)) verdict = "connected";
    else if ([...holders.values()].some((s) => s.size > 1)) verdict = "shared within one item";
    else if (subjectsKeyed.size < 2) verdict = "not tied";
    else if (new Set(keyed.map((h) => h.scope)).size > 1) verdict = "different scope";
    else verdict = "same scope, different entity";
    out.push({ name, verdict, holdings: all });
  }
  const order: Recurring["verdict"][] = [
    "connected",
    "shared within one item",
    "different scope",
    "same scope, different entity",
    "not tied",
  ];
  return out.sort((a, b) =>
    order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.name.localeCompare(b.name)
  );
}

function measureLabel(b: BallotRecord, key: string): string | null {
  return b.reading ? measuresOf(b.reading)[Number(key.slice(1))]?.label ?? null : null;
}

/** One report per ballot, items in ballot order: contests, then measures. */
export function diagnose(
  ballots: readonly BallotRecord[],
  runs: ReadonlyMap<string, RunRecord>,
): BallotReport[] {
  return ballots.map((b) => {
    const keys = Object.keys(b.started).sort((x, y) => {
      const m = (k: string) => k.startsWith("m");
      return Number(m(x)) - Number(m(y)) ||
        Number(x.replace("m", "")) - Number(y.replace("m", ""));
    });
    const built = keys.map((key) => {
      const run = runs.get(b.started[key]);
      const label = run?.measure?.label ??
        run?.query.office ??
        (key.startsWith("m") ? measureLabel(b, key) : b.reading?.contests[Number(key)]?.office) ??
        key;
      return itemOf(key, label, run);
    });
    const items = built.map((x) => x.item);
    const subjects = built.flatMap((x) => x.subjects);
    const scopes: Record<string, string[]> = {};
    for (const it of items) if (it.scope) (scopes[it.scope] ??= []).push(it.label);
    const recurring = recurringNames(subjects);
    const count = (v: Recurring["verdict"]) => recurring.filter((r) => r.verdict === v).length;
    const subs = items.flatMap((i) => i.subjects);
    return {
      ballot: b.id,
      created_at: b.created_at,
      items,
      scopes,
      recurring,
      totals: {
        subjects: subs.length,
        subjects_with_money: subs.filter((s) => s.finance.kept > 0).length,
        contributions_kept: subs.reduce((n, s) => n + s.finance.kept, 0),
        verified_notes: items.reduce((n, i) => n + i.context.verified_notes, 0),
        ties: subs.reduce((n, s) => n + s.ties.contribution + s.ties.named, 0),
        shared_within_items: items.reduce((n, i) => n + i.shared_within, 0),
        connected_across_items: count("connected"),
        blocked_by_scope: count("different scope"),
        blocked_by_entity_rule: count("same scope, different entity"),
        not_tied: count("not tied"),
      },
    };
  });
}

export function formatReport(reports: readonly BallotReport[]): string {
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  if (!reports.length) line("No ballots with researched items.");
  for (const r of reports) {
    const t = r.totals;
    line(`=== Ballot ${r.ballot} (${r.created_at ?? "?"}) ===`);
    line();
    line("Summary");
    line(`  ${r.items.length} item(s), ${t.subjects} subject(s) (candidates and measure sides)`);
    line(`  ${t.subjects_with_money} subject(s) with any verified contribution kept;`);
    line(`    ${t.contributions_kept} contribution row(s) kept in all`);
    line(`  ${t.verified_notes} verified context note(s) across all items`);
    line(`  ${t.ties} tie(s) the connections views can match on`);
    line(`  ${t.shared_within_items} pair(s) within one item that share something`);
    line(`  Names recurring across subjects: ${r.recurring.length}`);
    line(`    connected across items:            ${t.connected_across_items}`);
    line(`    tied on both sides, scopes differ: ${t.blocked_by_scope}`);
    line(`    same scope, kept as two entities:  ${t.blocked_by_entity_rule}`);
    line(`    named, but not a tie on 2+ sides:  ${t.not_tied}`);
    line();
    line("Scopes (entity pages compare only within one)");
    for (const [scope, labels] of Object.entries(r.scopes)) {
      line(`  ${scope}: ${labels.join("; ")}`);
    }
    line();
    line("Items");
    for (const it of r.items) {
      line(
        `  [${it.key}] ${it.label} (${it.kind}, ${it.place || "?"}) run ${it.run_id ?? "-"}: ` +
          it.status,
      );
      const c = it.context;
      line(
        `      context: ${c.state}${c.error ? ` (${c.error})` : ""}; names found ${c.found}, ` +
          `verified notes ${c.verified_notes}, unverified ${c.unverified_notes}, ` +
          `no sourced note ${c.not_described}, not needed ${c.not_needed}, over cap ${c.over_cap}`,
      );
      const f = it.finance;
      line(
        `      finance: ${f.state}${f.error ? ` (${f.error})` : ""}` +
          (f.portal_gaps.length ? `; portal gaps: ${f.portal_gaps.join("; ")}` : ""),
      );
      for (const s of it.subjects) {
        const m = s.finance;
        const money = !m.found
          ? "no finance result"
          : m.opened_nothing
          ? "opened no pages"
          : `kept ${m.kept} (org ${m.organizations}, individual ${m.individuals} ` +
            `[${m.identifying} identifying], untyped ${m.untyped}), unverified ${m.unverified}, ` +
            `dropped ${m.dropped}, over share ${m.over_share}`;
        line(
          `      - ${s.label}: ${money}; support names ${s.support_names}; ties: ` +
            `gave ${s.ties.contribution}, endorses ${s.ties.named}`,
        );
        if (m.found && !m.kept && m.gap_note && !m.opened_nothing) {
          line(`          gap: ${m.gap_note.slice(0, 160)}${m.gap_note.length > 160 ? "…" : ""}`);
        }
      }
    }
    line();
    line("Names recurring across subjects");
    if (!r.recurring.length) line("  (none)");
    for (const n of r.recurring) {
      line(`  ${n.name}: ${n.verdict}`);
      for (const h of n.holdings) {
        line(`      ${h.item} / ${h.subject} [${h.scope}]: ${h.how}`);
      }
    }
    line();
  }
  return out.join("\n");
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["ballot", "data"],
    boolean: ["json", "help"],
    default: { data: Deno.env.get("BALLOTFIX_DATA_DIR") ?? "data" },
  });
  if (args.help) {
    console.log("deno task diagnose [--ballot <id>] [--json] [--data <dir>]");
    Deno.exit(0);
  }
  const db = new DatabaseSync(`${args.data}/ballotfix.db`, { readOnly: true });
  const rows = (table: string) =>
    (db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[])
      .map((r) => JSON.parse(r.body));
  const runs = new Map((rows("runs") as RunRecord[]).map((r) => [r.id, r]));
  const ballots = (rows("ballots") as BallotRecord[])
    .filter((b) => Object.keys(b.started).length && (!args.ballot || b.id === args.ballot))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  db.close();
  const reports = diagnose(ballots, runs);
  console.log(args.json ? JSON.stringify(reports, null, 2) : formatReport(reports));
}
