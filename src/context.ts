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
 *   same share of names, and the names left out are listed on the page, as
 *   are names the model judged need no note and names it couldn't describe.
 * - The request never labels which candidate or side a name came from, and
 *   the candidates' names in the statements it quotes are replaced.
 * - A failed call is recorded on the dossier, so the page says why the
 *   names it lists have no notes.
 * - A name that already has a verified note from an earlier run in the same
 *   place (state + jurisdiction) reuses it instead of being sent again, so
 *   the cap goes to names nobody has described yet. The page says which
 *   notes came from an earlier lookup, and when.
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
  wisconsin wyoming californians americans legislature legislative senate assembly congress
  constitution constitutional amendment initiative statute law act bill`).split(/\s+/),
);

/** A run starting with one of these is a ballot item or a law, not a name. */
const NOT_NAMES = new Set(["measure", "proposition", "prop", "resolution", "ordinance", "section"]);

/**
 * "Yes on ..." and "No on ..." are a measure's own sides, which the page already names
 * ("Yes on 43" ends at "Yes", since "on" can't end a name). Only those: "No Labels" and
 * "Yes In My Back Yard" are names.
 */
const isSide = (words: readonly string[]) =>
  (words[0] === "yes" || words[0] === "no") && (words.length === 1 || words[1] === "on");

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
 * What `findNames` leaves out: `words`, the candidates' and the place's own
 * words (a run made only of these and generic words is dropped), and
 * `people`, the candidates' full names (a run that is all or part of one is
 * dropped, but "Friends of Jane Doe", a committee, is kept).
 */
export interface Exclusions {
  words: ReadonlySet<string>;
  people: readonly string[];
}

const NOTHING_EXCLUDED: Exclusions = { words: new Set(), people: [] };

export function exclusions(people: readonly string[], places: readonly string[]): Exclusions {
  const words = new Set<string>();
  for (const s of [...people, ...places]) {
    // A candidate's surname or the city's name alone ("Warren voted", "Fontana's budget").
    for (const w of nameKey(s).split(" ")) if (w.length > 2) words.add(w);
  }
  return { words, people: people.map(nameKey).filter(Boolean) };
}

/**
 * Candidate names in one statement: runs of capitalized words (with "of",
 * "for", ... inside, and "Local 1000" after a union's name), minus titles,
 * sentence openers, generic words, ballot items, and what `exclude` names.
 * A heuristic: it misses some names (a one-word name opening a sentence,
 * "Chevron gave...") and finds some non-names, which the model skips. The
 * page says names were picked out automatically and some may be missed.
 */
export function findNames(statement: string, exclude: Exclusions = NOTHING_EXCLUDED): string[] {
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
    // A title or opener comes off the front, but not one that starts a name: "Justice for Janitors".
    while (
      r.length &&
      (!isCap(r[0].word) ||
        (LEADING.has(r[0].word.toLowerCase()) && !CONNECTORS.has(r[1]?.word.toLowerCase() ?? "")))
    ) {
      r = r.slice(1);
    }
    while (r.length && !isCap(r.at(-1)!.word) && !/^\d+$/.test(r.at(-1)!.word)) r = r.slice(0, -1);
    if (!r.length) continue;
    const words = r.map((t) => t.word.toLowerCase());
    if (NOT_NAMES.has(words[0]) || isSide(words)) continue;
    if (words.every((w) => GENERIC.has(w) || CONNECTORS.has(w) || exclude.words.has(nameKey(w)))) {
      continue;
    }
    if (r.length === 1) {
      const w = r[0].word;
      if (r[0] === first && first.sentenceStart && !isAcronym(w)) continue;
      if (w.length < 3 && !isAcronym(w)) continue;
    }
    const name = statement.slice(r[0].start, r.at(-1)!.end);
    const k = ` ${nameKey(name)} `;
    if (exclude.people.some((p) => ` ${p} `.includes(k))) continue;
    out.push(name);
  }
  return [...new Set(out)];
}

/**
 * A statement as the request shows it: cut short, with the candidates' names
 * replaced, so the model looks up every name the same way whoever it came up for.
 */
export function redact(statement: string, people: readonly string[]): string {
  let s = statement;
  const parts = [
    ...people,
    ...people.flatMap((p) => p.split(/\s+/).filter((w) => w.length > 2)),
  ].sort((a, b) => b.length - a.length);
  for (const p of parts) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"),
      "[candidate]",
    );
  }
  // One "[candidate]" for a full name, not one per word.
  s = s.replace(/\[candidate\](\s+\[candidate\])+/g, "[candidate]");
  return s.length > MAX_MENTION_CHARS ? `${s.slice(0, MAX_MENTION_CHARS)}…` : s;
}

// ---------------------------------------------------------------------------
// Choosing which names to send
// ---------------------------------------------------------------------------

interface Found {
  name: string;
  key: string;
  /** The first statement naming it, per subject. */
  mentions: Map<number, string>;
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
 * Collects names from each subject's statements, then sends up to the cap in
 * rounds: each round, every subject with names left adds its next
 * most-mentioned one. Only whole rounds are sent, so ballot order never
 * buys a subject an extra name; what doesn't fit is listed as not looked up.
 * A name already taken for another subject serves both, and this subject
 * takes its next one. Names in `known` (keys of notes reused from earlier
 * runs) are set aside as `reused` first and never count against the cap.
 */
export function chooseNames(
  subjects: readonly string[][],
  exclude: Exclusions,
  cap = MAX_CONTEXT_NAMES,
  known: ReadonlySet<string> = new Set(),
): { chosen: Found[]; left: Found[]; reused: Found[] } {
  const byKey = new Map<string, Found>();
  subjects.forEach((stmts, subject) => {
    for (const s of stmts) {
      for (const name of findNames(s, exclude)) {
        const key = nameKey(name);
        let f = byKey.get(key);
        if (!f) byKey.set(key, f = { name, key, mentions: new Map(), count: new Map() });
        if (!f.mentions.has(subject)) f.mentions.set(subject, s);
        f.count.set(subject, (f.count.get(subject) ?? 0) + 1);
      }
    }
  });
  const reused = [...byKey.values()].filter((f) => known.has(f.key));
  const all = [...byKey.values()].filter((f) => !known.has(f.key));
  const queues = subjects.map((_, subject) =>
    all.filter((f) => f.count.has(subject))
      .sort((a, b) => b.count.get(subject)! - a.count.get(subject)!)
  );
  const picked = new Set<Found>();
  const next = queues.map(() => 0);
  for (;;) {
    const round = new Set<Found>();
    queues.forEach((q, i) => {
      while (next[i] < q.length && (picked.has(q[next[i]]) || round.has(q[next[i]]))) next[i]++;
      if (next[i] < q.length) round.add(q[next[i]++]);
    });
    if (!round.size || picked.size + round.size > cap) break;
    for (const f of round) picked.add(f);
  }
  return {
    chosen: all.filter((f) => picked.has(f)),
    left: all.filter((f) => !picked.has(f)),
    reused,
  };
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
 * One entry per name sent: a note, not_needed (the model judged it isn't a
 * specific person or organization, or that nearly every voter knows it), or
 * not_described (left out of the answer, or described in a way that can't be
 * shown). The page lists both lists: no name is dropped silently.
 */
export function checkNotes(
  sent: readonly NameToDescribe[],
  raw: readonly RawContextNote[],
  retrievedUrls: readonly string[],
): { notes: ContextNote[]; not_described: string[]; not_needed: string[] } {
  const retrieved = new Set(
    retrievedUrls.map(normalizeUrl).filter((u): u is string => u !== null),
  );
  const answers = new Map<string, RawContextNote>();
  for (const r of raw) if (!answers.has(r.id)) answers.set(r.id, r);
  const notes: ContextNote[] = [];
  const not_described: string[] = [];
  const not_needed: string[] = [];
  for (const n of sent) {
    const a = answers.get(n.id);
    if (a && clean(a.kind) === "skip") {
      not_needed.push(n.name);
      continue;
    }
    const note = a ? toNote(n.name, a, retrieved) : null;
    if (note) notes.push(note);
    else not_described.push(n.name);
  }
  return { notes, not_described, not_needed };
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
  /** Names given a note from an earlier run instead of being sent. */
  reused: number;
}

/**
 * Verified notes from earlier runs in the same place, to reuse rather than
 * look up again: newest first, so the newest note for a name wins.
 */
export type KnownNotes = readonly ContextNote[];

/**
 * The verified notes a finished run holds, as reusable notes: each keeps the
 * run whose lookup retrieved its page (the first one, when it was reused).
 */
export function notesToReuse(
  context: ContextResult | undefined,
  run: { id: string; updated_at: string },
): ContextNote[] {
  return (context?.notes ?? []).filter((n) => n.verified).map((n) => ({
    ...n,
    reused_from: n.reused_from ?? { run: run.id, looked_up: run.updated_at },
  }));
}

/** This run's own spelling of each reused name, with the earlier note. */
function reuse(found: readonly Found[], known: KnownNotes): ContextNote[] {
  const byKey = new Map<string, ContextNote>();
  for (const n of known) {
    const k = nameKey(n.name);
    if (n.verified && n.reused_from && !byKey.has(k)) byKey.set(k, n);
  }
  return found.flatMap((f) => {
    const n = byKey.get(f.key);
    return n ? [{ ...n, name: f.name }] : [];
  });
}

const knownKeys = (known: KnownNotes) =>
  new Set(known.filter((n) => n.verified && n.reused_from).map((n) => nameKey(n.name)));

/** Everything the step needs from a dossier, before any call. */
interface Plan {
  subjects: string[][];
  exclude: Exclusions;
  /** Candidates' names, replaced in what is sent. */
  people: string[];
  place: string;
  electionDate: string;
}

function racePlan(race: RaceDossier): Plan {
  const q = race.query;
  const people = race.candidates.map((c) => c.candidate.name);
  return {
    subjects: race.candidates.filter((c) => c.status === "ok").map((c) =>
      statements([...Object.values(c.sections), ...priorityResults(c.priorities)])
    ),
    exclude: exclusions(people, [q.city]),
    people,
    place: `${q.city}, ${q.state}`,
    electionDate: q.electionDate,
  };
}

/**
 * A measure's names come in three equal shares: the case for, the case
 * against, and everything else, so neither side's names crowd out the other's.
 */
function measurePlan(m: MeasureDossier): Plan {
  const q = m.query;
  const { case_for, case_against, ...rest } = m.sections;
  return {
    subjects: m.status === "ok"
      ? [
        statements([case_for]),
        statements([case_against]),
        [
          ...[m.vote_means?.yes, m.vote_means?.no].flatMap((f) => f ? [f.statement] : []),
          ...statements([...Object.values(rest), ...priorityResults(m.priorities)]),
        ],
      ]
      : [],
    exclude: exclusions(m.query.label ? [m.query.label] : [], [q.jurisdiction]),
    people: [],
    place: [q.jurisdiction, q.state].filter(Boolean).join(", "),
    electionDate: q.electionDate,
  };
}

async function describe(
  plan: Plan,
  writer: ContextWriter,
  known: KnownNotes,
): Promise<ContextResult & { sent: number; reused: number }> {
  const { chosen, left, reused } = chooseNames(
    plan.subjects,
    plan.exclude,
    MAX_CONTEXT_NAMES,
    knownKeys(known),
  );
  const earlier = reuse(reused, known);
  const empty = { notes: earlier, not_described: [], not_needed: [], model: null };
  const not_looked_up = left.map((f) => f.name);
  if (!chosen.length) return { ...empty, not_looked_up, sent: 0, reused: earlier.length };
  const names = chosen.map((f, i) => ({
    id: `n${i + 1}`,
    name: f.name,
    // From different subjects where it came up for several: better for telling who it is.
    mentions: [...f.mentions.values()].slice(0, MAX_MENTIONS).map((s) => redact(s, plan.people)),
  }));
  const r = await writer.describeNames({
    place: plan.place,
    electionDate: plan.electionDate,
    names,
  });
  const checked = checkNotes(names, r.notes, r.retrieved_urls);
  return {
    ...checked,
    notes: [...earlier, ...checked.notes],
    not_looked_up,
    model: r.model,
    sent: names.length,
    reused: earlier.length,
  };
}

function finish<T extends { context?: ContextResult }>(
  d: T,
  r: ContextResult & { sent: number; reused: number },
): ContextStepResult<T> {
  const { sent, reused, ...context } = r;
  const found = sent + reused + context.not_looked_up.length;
  return {
    // Nothing to say when the facts name no one: the dossier stays as it was.
    dossier: found ? { ...d, context } : d,
    sent,
    shown: context.notes.filter((n) => n.verified).length,
    skipped: context.not_looked_up.length,
    reused,
  };
}

/**
 * One call for the whole race; every candidate's names get the same share and the same call.
 * `known`: verified notes from earlier runs in the same place (notesToReuse), reused as is.
 */
export async function contextForRace(
  race: RaceDossier,
  writer: ContextWriter,
  known: KnownNotes = [],
): Promise<ContextStepResult<RaceDossier>> {
  return finish(race, await describe(racePlan(race), writer, known));
}

export async function contextForMeasure(
  m: MeasureDossier,
  writer: ContextWriter,
  known: KnownNotes = [],
): Promise<ContextStepResult<MeasureDossier>> {
  return finish(m, await describe(measurePlan(m), writer, known));
}

/**
 * The dossier after a failed context call: every name found is listed as not
 * looked up, with why, so the page says what is missing. Unchanged when the
 * facts name no one.
 */
function failed<T extends { context?: ContextResult }>(
  d: T,
  plan: Plan,
  error: string,
  known: KnownNotes,
): T {
  const { chosen, left, reused } = chooseNames(
    plan.subjects,
    plan.exclude,
    Infinity,
    knownKeys(known),
  );
  const names = [...chosen, ...left].map((f) => f.name);
  const earlier = reuse(reused, known);
  if (!names.length && !earlier.length) return d;
  return {
    ...d,
    context: {
      // Reused notes needed no call, so the failure doesn't take them away.
      notes: earlier,
      not_looked_up: names,
      not_described: [],
      not_needed: [],
      model: null,
      error,
    },
  };
}

export const raceContextFailed = (race: RaceDossier, error: string, known: KnownNotes = []) =>
  failed(race, racePlan(race), error, known);
export const measureContextFailed = (m: MeasureDossier, error: string, known: KnownNotes = []) =>
  failed(m, measurePlan(m), error, known);

// ---------------------------------------------------------------------------
// Where a note attaches
// ---------------------------------------------------------------------------

/** A statement split at the names that have a shown note: text, or a name with its note. */
export type Piece = string | { text: string; note: ContextNote };

/**
 * Splits a statement at the first place each verified note's name appears,
 * longest names first, whole words only, any case. Used by the page and the graph, so
 * a note attaches in both or neither.
 */
export function attachNotes(statement: string, notes: readonly ContextNote[]): Piece[] {
  const hits: { start: number; end: number; note: ContextNote }[] = [];
  const shown = notes.filter((n) => n.verified).sort((a, b) => b.name.length - a.name.length);
  // Case doesn't matter ("ACME Builders" in one fact, "Acme Builders" in another), unless
  // lowercasing changes the length, which would shift every position.
  const lower = statement.toLowerCase();
  for (const note of shown) {
    const lowerName = note.name.toLowerCase();
    const exact = lower.length !== statement.length || lowerName.length !== note.name.length;
    const [text, name] = exact ? [statement, note.name] : [lower, lowerName];
    let from = 0;
    while (from <= statement.length) {
      const i = text.indexOf(name, from);
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
