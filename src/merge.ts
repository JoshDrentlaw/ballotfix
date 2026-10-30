/**
 * Merges duplicate claims: verified facts in one section that state the same
 * thing, from different sources, become one fact with several citations, so
 * the page can say "reported by N sources" instead of repeating it.
 *
 * One capped model call per run (ClaimMerger) proposes groups. Everything
 * here checks them, so a bad answer can at worst miss a merge, never make a
 * wrong one cross a boundary:
 * - Only verified facts take part. Unverified ones are never sent, never
 *   gain a citation, and never lend one: the provenance check stands as is.
 * - A group stays inside one section of one candidate or measure. A group
 *   that spans people, measures, or sections is dropped whole.
 * - A group's facts share one evidence type and one quote-check level, so
 *   the tag and the level still describe every citation under it.
 * - Each publisher (and each page) counts once, so N counts outlets.
 * - Known event dates in a group agree (one may be the year or month of
 *   another), so a merged fact describes one event.
 * - The fact shown is the group's earliest in dossier order, in its source's
 *   words; the others are kept on it as `also`. The model writes no text.
 * - The same rule and the same call cover every candidate in the run.
 */

import { nameKey } from "./knowledge.ts";
import { normalizeUrl } from "./dossier.ts";
import { MEASURE_SECTIONS, priorityId, SECTIONS } from "./template.ts";
import type {
  CandidateDossier,
  ClaimMerger,
  Fact,
  MeasureDossier,
  MergeBlock,
  PriorityResult,
  RaceDossier,
  SectionResult,
} from "./types.ts";

/**
 * Most facts sent in one call; sections past the cap are left unmerged. Bounds
 * cost. Over the cap, each candidate or measure gets an equal share.
 */
export const MAX_MERGE_FACTS = 240;
/**
 * Statements are cut to this length in the request, marked "[cut]"; the page
 * always shows them whole.
 */
export const MAX_MERGE_STATEMENT_CHARS = 500;

/** One section of one subject, as the merge step sees it. */
interface Part {
  id: string;
  title: string;
  result: SectionResult;
}

interface Subject {
  label: string;
  parts: Part[];
}

interface Slot {
  subject: number;
  part: string;
  index: number;
  fact: Fact;
}

/** A checked group: indices into one part's facts, earliest first. */
interface Group {
  subject: number;
  part: string;
  indices: number[];
}

export interface MergeResult<T> {
  dossier: T;
  /** Groups merged. */
  groups: number;
  /** Facts sent to the merger; 0 means no call was made. */
  sent: number;
  /** Facts in sections left out because of MAX_MERGE_FACTS. */
  skipped: number;
}

/** Each outlet is one source, however many of its pages were cited. */
export const publisherKey = (f: Fact) => nameKey(f.source_name);

function priorityParts(p: readonly PriorityResult[] | undefined): Part[] {
  return (p ?? []).map((x, i) => ({ id: priorityId(i), title: x.issue, result: x.result }));
}

function candidateSubject(d: CandidateDossier): Subject {
  return {
    label: d.candidate.name,
    parts: [
      // Runs saved before a section existed lack it.
      ...SECTIONS.flatMap((s) =>
        d.sections[s.id] ? [{ id: s.id, title: s.title, result: d.sections[s.id] }] : []
      ),
      ...priorityParts(d.priorities),
    ],
  };
}

function measureSubject(m: MeasureDossier): Subject {
  return {
    label: m.query.label,
    parts: [
      ...MEASURE_SECTIONS.flatMap((s) =>
        m.sections[s.id] ? [{ id: s.id, title: s.title, result: m.sections[s.id] }] : []
      ),
      ...priorityParts(m.priorities),
    ],
  };
}

/** Worth asking about: two or more facts from two or more outlets, none merged already. */
function eligible(r: SectionResult): boolean {
  return r.facts.length >= 2 && !r.facts.some((f) => f.also?.length) &&
    new Set(r.facts.map(publisherKey)).size >= 2;
}

/** A statement as the request shows it; a cut one is marked so the model knows (MERGE_SYSTEM). */
function clip(statement: string): string {
  return statement.length > MAX_MERGE_STATEMENT_CHARS
    ? `${statement.slice(0, MAX_MERGE_STATEMENT_CHARS)} [cut]`
    : statement;
}

function plan(subjects: readonly Subject[]) {
  const blocks: MergeBlock[] = [];
  const slots = new Map<string, Slot>();
  let skipped = 0;
  const parts = subjects.map((s) => s.parts.filter((p) => eligible(p.result)));
  const total = parts.flat().reduce((n, p) => n + p.result.facts.length, 0);
  // Over the cap, every subject gets the same share, so ballot order never
  // decides whose facts are merged and whose are left out.
  const share = total > MAX_MERGE_FACTS
    ? Math.floor(MAX_MERGE_FACTS / parts.filter((ps) => ps.length).length)
    : MAX_MERGE_FACTS;
  subjects.forEach((s, subject) => {
    let taken = 0;
    for (const part of parts[subject]) {
      const n = part.result.facts.length;
      if (taken + n > share) {
        skipped += n;
        continue;
      }
      taken += n;
      blocks.push({
        label: `${s.label} — ${part.title}`,
        facts: part.result.facts.map((fact, index) => {
          const id = `f${slots.size + 1}`;
          slots.set(id, { subject, part: part.id, index, fact });
          return { id, statement: clip(fact.statement), source_name: fact.source_name };
        }),
      });
    }
  });
  return { blocks, slots, skipped };
}

/** Two event dates that can be the same day: equal, or one a year or month of the other. */
const sameEvent = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** Keeps only groups that obey the rules in this file's header; each fact joins one group. */
function checkGroups(raw: unknown, slots: ReadonlyMap<string, Slot>): Group[] {
  const used = new Set<string>();
  const out: Group[] = [];
  for (const ids of Array.isArray(raw) ? raw : []) {
    const members = [...new Set(Array.isArray(ids) ? ids : [])]
      .filter((id): id is string => typeof id === "string" && slots.has(id) && !used.has(id))
      .map((id) => ({ id, ...slots.get(id)! }));
    if (members.length < 2) continue;
    const { subject, part } = members[0];
    if (members.some((m) => m.subject !== subject || m.part !== part)) continue;
    // The merged fact shows one chip for all (render.ts), so its facts must share
    // everything the chip says: level, and whether the page was opened and read.
    // Facts from runs before quote checks have none; they group among themselves.
    const byType = Map.groupBy(members, (m) => {
      const c = m.fact.check;
      return `${m.fact.evidence_type} ${c ? `${c.level} ${c.opened} ${c.read}` : ""}`;
    });
    for (const same of byType.values()) {
      same.sort((a, b) => a.index - b.index);
      // Facts that agree with the date most of the group shares go first, so
      // one outlier date can't keep the rest apart; the kept fact is still
      // the earliest in dossier order.
      const dated = same.map((m) => m.fact.event_date).filter((d): d is string => !!d);
      const agree = (d: string | null | undefined, anchor: string) => !d || sameEvent(d, anchor);
      const anchor = dated.reduce<string | null>((best, d) =>
        best === null ||
          same.filter((m) => agree(m.fact.event_date, d)).length >
            same.filter((m) => agree(m.fact.event_date, best)).length
          ? d
          : best, null);
      const ordered = anchor === null ? same : [
        ...same.filter((m) => agree(m.fact.event_date, anchor)),
        ...same.filter((m) => !agree(m.fact.event_date, anchor)),
      ];
      const outlets = new Set<string>(), pages = new Set<string>();
      const dates: string[] = [];
      const kept = ordered.filter((m) => {
        const outlet = publisherKey(m.fact), page = normalizeUrl(m.fact.source_url) ?? "";
        if (outlets.has(outlet) || pages.has(page)) return false;
        // Two event dates that disagree are two events, whatever the words.
        const when = m.fact.event_date;
        if (when && dates.some((d) => !sameEvent(d, when))) return false;
        outlets.add(outlet);
        pages.add(page);
        if (when) dates.push(when);
        return true;
      });
      if (kept.length < 2) continue;
      kept.sort((a, b) => a.index - b.index);
      for (const m of kept) used.add(m.id);
      out.push({ subject, part, indices: kept.map((m) => m.index) });
    }
  }
  return out;
}

/** The part's facts with each group folded into its earliest fact. */
function applyGroups(r: SectionResult, groups: readonly Group[]): SectionResult {
  const folded = new Map<number, number[]>();
  const removed = new Set<number>();
  for (const g of groups) {
    const [first, ...rest] = g.indices;
    folded.set(first, rest);
    for (const i of rest) removed.add(i);
  }
  const facts = r.facts.flatMap((f, i): Fact[] => {
    if (removed.has(i)) return [];
    const rest = folded.get(i);
    return rest ? [{ ...f, also: rest.map((j) => r.facts[j]) }] : [f];
  });
  return { ...r, facts };
}

/** Per subject, the parts that changed. */
async function mergeSubjects(
  subjects: readonly Subject[],
  merger: ClaimMerger,
): Promise<
  { changed: Map<string, SectionResult>[]; groups: number; sent: number; skipped: number }
> {
  const changed = subjects.map(() => new Map<string, SectionResult>());
  const { blocks, slots, skipped } = plan(subjects);
  if (!blocks.length) return { changed, groups: 0, sent: 0, skipped };
  const groups = checkGroups(await merger.groupDuplicates(blocks), slots);
  for (const gs of Map.groupBy(groups, (g) => `${g.subject}|${g.part}`).values()) {
    const { subject, part } = gs[0];
    const r = subjects[subject].parts.find((p) => p.id === part)!.result;
    changed[subject].set(part, applyGroups(r, gs));
  }
  return { changed, groups: groups.length, sent: slots.size, skipped };
}

function withParts<T extends { sections: Record<string, SectionResult> }>(
  d: T & { priorities?: PriorityResult[] },
  changed: ReadonlyMap<string, SectionResult>,
): T {
  if (!changed.size) return d;
  const sections = { ...d.sections };
  for (const id of Object.keys(sections)) {
    const r = changed.get(id);
    if (r) sections[id] = r;
  }
  const priorities = d.priorities?.map((p, i) => {
    const r = changed.get(priorityId(i));
    return r ? { ...p, result: r } : p;
  });
  return { ...d, sections, ...(priorities ? { priorities } : {}) };
}

/** One call for the whole race; each candidate's facts only ever merge with their own. */
export async function mergeRace(
  race: RaceDossier,
  merger: ClaimMerger,
): Promise<MergeResult<RaceDossier>> {
  const done = race.candidates.map((c, i) => ({ c, i })).filter(({ c }) => c.status === "ok");
  const r = await mergeSubjects(done.map(({ c }) => candidateSubject(c)), merger);
  const candidates = [...race.candidates];
  done.forEach(({ c, i }, k) => (candidates[i] = withParts(c, r.changed[k])));
  return {
    dossier: r.groups ? { ...race, candidates } : race,
    groups: r.groups,
    sent: r.sent,
    skipped: r.skipped,
  };
}

export async function mergeMeasure(
  m: MeasureDossier,
  merger: ClaimMerger,
): Promise<MergeResult<MeasureDossier>> {
  if (m.status !== "ok") return { dossier: m, groups: 0, sent: 0, skipped: 0 };
  const r = await mergeSubjects([measureSubject(m)], merger);
  return {
    dossier: withParts(m, r.changed[0]),
    groups: r.groups,
    sent: r.sent,
    skipped: r.skipped,
  };
}

/** How many sources a fact stands for: itself plus what was merged into it. */
export function sourceCount(f: Fact): number {
  return 1 + (f.also?.length ?? 0);
}
