/**
 * Context notes: short, sourced answers to "who is that?" for the people and
 * organizations a run's facts name (a PAC, a developer, a union local, a
 * former council member), so the voter doesn't have to look each one up.
 *
 * One capped model call per run (ContextWriter), after the merge step. Names
 * are found here, without a model, so the cap is applied before anything is
 * sent and can be applied fairly. Everything that comes back is checked:
 * - Only names found in verified facts are sent; the answer can describe
 *   only those ids, so the model can't add a name.
 * - A note is shown only if its URL is a page the call actually retrieved.
 *   Other notes are kept as unverified and never shown next to a name.
 * - A note must be one short, neutral description. One that uses an
 *   evaluative word (CHARACTERIZATIONS) is not shown at all.
 * - Over the cap, every candidate (or, for a measure, each side) gets the
 *   same share of names, and the names left out are listed on the page.
 * - The request never says which candidate or side a name came from.
 */

import { normalizeUrl } from "./dossier.ts";
import { nameKey } from "./knowledge.ts";
import {
  CONTEXT_KINDS,
  type ContextKind,
  type ContextNote,
  type ContextResult,
  type ContextWriter,
  type Fact,
  type MeasureDossier,
  type NameToDescribe,
  type PriorityResult,
  type RaceDossier,
  type RawContextNote,
  type SectionResult,
} from "./types.ts";

/** Most names sent in one call. Bounds cost; the rest are listed as not looked up. */
export const MAX_CONTEXT_NAMES = 30;
/** Statements shown per name, each cut to MAX_MENTION_CHARS, to tell same-named entities apart. */
export const MAX_MENTIONS = 2;
export const MAX_MENTION_CHARS = 300;
/** A note is one short sentence; a longer one is not shown rather than cut. */
export const MAX_NOTE_CHARS = 280;

/**
 * Evaluative words a "who is this" note has no use for. A note using one is
 * not shown: the step describes, it never characterizes.
 */
export const CHARACTERIZATIONS = [
  "controversial",
  "notorious",
  "infamous",
  "disgraced",
  "corrupt",
  "radical",
  "extremist",
  "extreme",
  "fringe",
  "shady",
  "dark money",
  "embattled",
  "divisive",
  "beloved",
  "respected",
  "renowned",
  "prominent",
  "influential",
  "powerful",
  "well known",
  "champion",
  "tireless",
  "scandal",
] as const;

// ---------------------------------------------------------------------------
// Finding names
// ---------------------------------------------------------------------------

/**
 * Lowercase words allowed inside a name: "Board of Realtors", "Friends for the Park". Not
 * "and": "a PAC and the Labor Council" is two names far more often than one.
 */
const CONNECTORS = new Set(["of", "for", "the", "&", "de", "del", "la", "los", "las", "on"]);

/** Titles and sentence openers stripped from the front of a run of capitalized words. */
const LEADING = new Set(
  (`the a an in on at according after before during his her their its this that these those
  under when while as by for from with it he she they we both each some many several former
  then mayor councilmember councilwoman councilman council member supervisor judge justice
  senator sen assemblymember assemblyman assemblywoman rep representative gov governor
  president chair chairman chairwoman commissioner trustee director dr mr ms mrs sheriff chief
  vice deputy candidate incumbent challenger placeholder`).split(/\s+/),
);

/** Words that are never a name a voter needs explained, alone or together. */
const GENERIC = new Set(
  (`city county state council board supervisors commission committee department district
  school unified court superior appeal appeals office general attorney plan planning budget
  police fire public works election elections registrar voters ballot measure proposition
  republican republicans democrat democrats democratic party gop independent united states
  america american federal government north south east west northern southern eastern western
  january february march april may june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday alabama alaska arizona arkansas
  california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa
  kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi
  missouri montana nebraska nevada new hampshire jersey mexico york carolina dakota ohio
  oklahoma oregon pennsylvania rhode island tennessee texas utah vermont virginia washington
  wisconsin wyoming`).split(/\s+/),
);

/** A run starting with one of these is a ballot item or a law, not a name. */
const NOT_NAMES = new Set(["measure", "proposition", "prop", "resolution", "ordinance", "section"]);

/** Abbreviations whose period doesn't end the sentence. */
const ABBREVIATIONS = new Set([
  "inc",
  "jr",
  "sr",
  "co",
  "corp",
  "st",
  "dr",
  "mr",
  "ms",
  "mrs",
  "no",
]);

const isCap = (w: string) => /^\p{Lu}/u.test(w);
const isAcronym = (w: string) => /^[\p{Lu}.&-]{2,}$/u.test(w) && /\p{Lu}.*\p{Lu}/u.test(w);

interface Token {
  word: string;
  start: number;
  end: number;
  /** First word of a sentence: its capital letter says nothing. */
  sentenceStart: boolean;
  /** Punctuation after it ends the run. */
  breaks: boolean;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  let sentenceStart = true;
  for (const m of text.matchAll(/\S+/g)) {
    let word = m[0];
    let start = m.index!;
    const lead = word.match(/^[("“‘'[]+/)?.[0].length ?? 0;
    word = word.slice(lead);
    start += lead;
    let breaks = false, endsSentence = false;
    const trail = word.match(/[)"”’'\],;:!?]+$/)?.[0] ?? "";
    if (trail) {
      word = word.slice(0, -trail.length);
      breaks = true;
      endsSentence = /[:!?]/.test(trail);
    }
    if (word.endsWith(".")) {
      const bare = word.slice(0, -1);
      if (!(ABBREVIATIONS.has(bare.toLowerCase()) || /^(\p{Lu}\.)+$/u.test(word))) {
        word = bare;
        breaks = true;
        endsSentence = true;
      }
    }
    const possessive = word.match(/['’]s$/);
    if (possessive) {
      word = word.slice(0, -2);
      breaks = true;
    }
    if (word) out.push({ word, start, end: start + word.length, sentenceStart, breaks });
    sentenceStart = endsSentence || (!word && sentenceStart);
  }
  return out;
}

/**
 * Candidate names in one statement: runs of capitalized words (with "of",
 * "for", ... inside, and "Local 1000" after a union's name), minus titles,
 * sentence openers, generic words, ballot items, and anything in `exclude`
 * (the candidates' own names, the place's own name). Crude on purpose: the
 * model skips what isn't a name worth a note, and a name it never sees is
 * listed on the page, not lost.
 */
export function findNames(statement: string, exclude: ReadonlySet<string> = new Set()): string[] {
  const ts = tokens(statement);
  const runs: Token[][] = [];
  let run: Token[] = [];
  const close = () => {
    if (run.length) runs.push(run);
    run = [];
  };
  for (const t of ts) {
    const prev = run.at(-1);
    const fits = isCap(t.word) ||
      (prev && CONNECTORS.has(t.word.toLowerCase())) ||
      (prev && /^\d+$/.test(t.word) && prev.word.toLowerCase() === "local");
    if (!fits) close();
    else run.push(t);
    if (t.breaks) close();
  }
  close();

  const out: string[] = [];
  for (let r of runs) {
    const first = r[0];
    while (r.length && (LEADING.has(r[0].word.toLowerCase()) || !isCap(r[0].word))) {
      r = r.slice(1);
    }
    while (r.length && !isCap(r.at(-1)!.word) && !/^\d+$/.test(r.at(-1)!.word)) r = r.slice(0, -1);
    if (!r.length) continue;
    const words = r.map((t) => t.word.toLowerCase());
    if (NOT_NAMES.has(words[0])) continue;
    if (words.every((w) => GENERIC.has(w) || CONNECTORS.has(w) || exclude.has(w))) continue;
    if (r.length === 1) {
      const w = r[0].word;
      if (r[0] === first && first.sentenceStart && !isAcronym(w)) continue;
      if (w.length < 3 && !isAcronym(w)) continue;
    }
    const name = statement.slice(r[0].start, r.at(-1)!.end);
    if (isExcluded(name, exclude)) continue;
    out.push(name);
  }
  return [...new Set(out)];
}

/** Excluded: the name is, or is part of, an excluded name (a candidate's surname alone, too). */
function isExcluded(name: string, exclude: ReadonlySet<string>): boolean {
  const k = ` ${nameKey(name)} `;
  for (const e of exclude) {
    if (e.includes(" ") && (` ${e} `.includes(k) || k.includes(` ${e} `))) return true;
  }
  return false;
}

/** What `findNames` leaves out for this run: the candidates, each of their words, and the place. */
function exclusions(people: readonly string[], places: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const s of [...people, ...places]) {
    const k = nameKey(s);
    if (!k) continue;
    out.add(k);
    // A candidate's surname or the city's name alone ("Warren voted", "Fontana's budget").
    for (const w of k.split(" ")) if (w.length > 2) out.add(w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Choosing which names to send
// ---------------------------------------------------------------------------

interface Found {
  name: string;
  key: string;
  mentions: string[];
  /** How many statements name it, per subject. */
  count: Map<number, number>;
}

/** Statements the voter sees as fact: verified facts only (merged ones once). */
function statements(results: readonly (SectionResult | undefined)[]): string[] {
  return results.flatMap((r) => (r?.facts ?? []).map((f: Fact) => f.statement));
}

function priorityResults(p: readonly PriorityResult[] | undefined): SectionResult[] {
  return (p ?? []).map((x) => x.result);
}

/**
 * Collects names from each subject's statements, then sends up to the cap,
 * round robin across subjects (each subject's most-mentioned names first),
 * so no subject's names crowd out another's whatever the ballot order.
 */
export function chooseNames(
  subjects: readonly string[][],
  exclude: ReadonlySet<string>,
  cap = MAX_CONTEXT_NAMES,
): { chosen: Found[]; left: Found[] } {
  const byKey = new Map<string, Found>();
  subjects.forEach((stmts, subject) => {
    for (const s of stmts) {
      for (const name of findNames(s, exclude)) {
        const key = nameKey(name);
        let f = byKey.get(key);
        if (!f) byKey.set(key, f = { name, key, mentions: [], count: new Map() });
        if (f.mentions.length < MAX_MENTIONS && !f.mentions.includes(s)) f.mentions.push(s);
        f.count.set(subject, (f.count.get(subject) ?? 0) + 1);
      }
    }
  });
  const all = [...byKey.values()];
  const queues = subjects.map((_, subject) =>
    all.filter((f) => f.count.has(subject))
      .sort((a, b) => b.count.get(subject)! - a.count.get(subject)!)
  );
  const picked = new Set<Found>();
  const next = queues.map(() => 0);
  let progress = true;
  while (picked.size < cap && progress) {
    progress = false;
    queues.forEach((q, i) => {
      if (picked.size >= cap) return;
      // A name another subject already took counts for both; take this subject's next one.
      while (next[i] < q.length && picked.has(q[next[i]])) next[i]++;
      if (next[i] < q.length) {
        picked.add(q[next[i]++]);
        progress = true;
      }
    });
  }
  return { chosen: all.filter((f) => picked.has(f)), left: all.filter((f) => !picked.has(f)) };
}

// ---------------------------------------------------------------------------
// Checking what comes back
// ---------------------------------------------------------------------------

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

/** The evaluative word a note uses, if any. Whole words, any case. */
export function characterization(note: string): string | null {
  const k = ` ${nameKey(note)} `;
  return CHARACTERIZATIONS.find((w) => k.includes(` ${nameKey(w)} `)) ?? null;
}

function toNote(
  name: string,
  raw: RawContextNote,
  retrieved: ReadonlySet<string>,
): ContextNote | null {
  const kind = clean(raw.kind);
  if (!(CONTEXT_KINDS as readonly string[]).includes(kind)) return null;
  const note = clean(raw.note);
  const source_url = clean(raw.source_url);
  const url = normalizeUrl(source_url);
  if (!note || note.length > MAX_NOTE_CHARS || characterization(note) || url === null) return null;
  return {
    name,
    kind: kind as ContextKind,
    note,
    source_name: clean(raw.source_name) || "source name not given",
    source_url,
    author: clean(raw.author) || null,
    published: clean(raw.published) || null,
    verified: retrieved.has(url),
  };
}

/**
 * One entry per name sent. A name the answer left out, or described in a way
 * that can't be shown, is listed in not_described: never dropped silently.
 */
export function checkNotes(
  sent: readonly NameToDescribe[],
  raw: readonly RawContextNote[],
  retrievedUrls: readonly string[],
): { notes: ContextNote[]; not_described: string[] } {
  const retrieved = new Set(
    retrievedUrls.map(normalizeUrl).filter((u): u is string => u !== null),
  );
  const answers = new Map<string, RawContextNote>();
  for (const r of raw) if (!answers.has(r.id)) answers.set(r.id, r);
  const notes: ContextNote[] = [];
  const not_described: string[] = [];
  for (const n of sent) {
    const a = answers.get(n.id);
    if (a && clean(a.kind) === "skip") continue;
    const note = a ? toNote(n.name, a, retrieved) : null;
    if (note) notes.push(note);
    else not_described.push(n.name);
  }
  return { notes, not_described };
}

// ---------------------------------------------------------------------------
// Running the step
// ---------------------------------------------------------------------------

export interface ContextStepResult<T> {
  dossier: T;
  /** Names sent; 0 means no call was made. */
  sent: number;
  /** Notes the page shows (verified). */
  shown: number;
  /** Names found but not sent, over MAX_CONTEXT_NAMES. */
  skipped: number;
}

const clip = (s: string) => s.length > MAX_MENTION_CHARS ? `${s.slice(0, MAX_MENTION_CHARS)}…` : s;

async function describe(
  subjects: readonly string[][],
  exclude: ReadonlySet<string>,
  place: string,
  electionDate: string,
  writer: ContextWriter,
): Promise<ContextResult & { sent: number }> {
  const { chosen, left } = chooseNames(subjects, exclude);
  const not_looked_up = left.map((f) => f.name);
  if (!chosen.length) return { notes: [], not_looked_up, not_described: [], model: null, sent: 0 };
  const names = chosen.map((f, i) => ({
    id: `n${i + 1}`,
    name: f.name,
    mentions: f.mentions.map(clip),
  }));
  const r = await writer.describeNames({ place, electionDate, names });
  const { notes, not_described } = checkNotes(names, r.notes, r.retrieved_urls);
  return { notes, not_looked_up, not_described, model: r.model, sent: names.length };
}

function finish<T extends { context?: ContextResult }>(
  d: T,
  r: ContextResult & { sent: number },
): ContextStepResult<T> {
  const { sent, ...context } = r;
  return {
    dossier: { ...d, context },
    sent,
    shown: context.notes.filter((n) => n.verified).length,
    skipped: context.not_looked_up.length,
  };
}

/** One call for the whole race; every candidate's names get the same share and the same call. */
export async function contextForRace(
  race: RaceDossier,
  writer: ContextWriter,
): Promise<ContextStepResult<RaceDossier>> {
  const done = race.candidates.filter((c) => c.status === "ok");
  const subjects = done.map((c) =>
    statements([...Object.values(c.sections), ...priorityResults(c.priorities)])
  );
  const exclude = exclusions(race.candidates.map((c) => c.candidate.name), [race.query.city]);
  const q = race.query;
  return finish(
    race,
    await describe(subjects, exclude, `${q.city}, ${q.state}`, q.electionDate, writer),
  );
}

/**
 * A measure's names come in three equal shares: the case for, the case
 * against, and everything else, so neither side's names crowd out the other's.
 */
export async function contextForMeasure(
  m: MeasureDossier,
  writer: ContextWriter,
): Promise<ContextStepResult<MeasureDossier>> {
  if (m.status !== "ok") return { dossier: m, sent: 0, shown: 0, skipped: 0 };
  const { case_for, case_against, ...rest } = m.sections;
  const subjects = [
    statements([case_for]),
    statements([case_against]),
    statements([...Object.values(rest), ...priorityResults(m.priorities)]),
  ];
  const q = m.query;
  const exclude = exclusions(m.query.label ? [m.query.label] : [], [q.jurisdiction]);
  const place = [q.jurisdiction, q.state].filter(Boolean).join(", ");
  return finish(m, await describe(subjects, exclude, place, q.electionDate, writer));
}

// ---------------------------------------------------------------------------
// Where a note attaches
// ---------------------------------------------------------------------------

/** A statement split at the names that have a shown note: text, or a name with its note. */
export type Piece = string | { text: string; note: ContextNote };

/**
 * Splits a statement at the first place each verified note's name appears,
 * longest names first, whole words only. Used by the page and the graph, so
 * a note attaches in both or neither.
 */
export function attachNotes(statement: string, notes: readonly ContextNote[]): Piece[] {
  const hits: { start: number; end: number; note: ContextNote }[] = [];
  const shown = notes.filter((n) => n.verified).sort((a, b) => b.name.length - a.name.length);
  for (const note of shown) {
    let from = 0;
    while (from <= statement.length) {
      const i = statement.indexOf(note.name, from);
      if (i < 0) break;
      const end = i + note.name.length;
      const wordEdge = !/[\p{L}\p{N}]/u.test(statement[i - 1] ?? "") &&
        !/[\p{L}\p{N}]/u.test(statement[end] ?? "");
      if (wordEdge && !hits.some((h) => i < h.end && end > h.start)) {
        hits.push({ start: i, end, note });
        break;
      }
      from = i + 1;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const out: Piece[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start > at) out.push(statement.slice(at, h.start));
    out.push({ text: statement.slice(h.start, h.end), note: h.note });
    at = h.end;
  }
  if (at < statement.length) out.push(statement.slice(at));
  return out;
}
