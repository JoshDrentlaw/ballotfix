/**
 * "On this ballot": how one item on a ballot connects to the ballot's other
 * items, from what the saved research already holds. No model or network
 * calls.
 *
 * Three kinds of connection, each shown with its sources:
 * - this item's verified facts that name another item: a measure by its
 *   label as written ("Proposition 40", "Prop. 40", "Props. 41 and 42",
 *   "Yes on 40"), a candidate by a given name and the surname together;
 * - the other item's verified facts that name this one, by the same rule;
 * - groups and contributors tied to both (ballotConnections, the Researched
 *   tab's matching, with each tie's supports/opposes mark where it has one).
 *
 * Matching is by the words alone, so it can over-match (a fact about an
 * earlier measure with the same number) and under-match (a surname alone, a
 * nickname not on the ballot). The page says both. Nothing is counted up
 * into a score, and no relation is named beyond the facts' own words.
 */

import {
  type BallotConnections,
  ballotConnections,
  type BallotItemDossier,
  type BallotShared,
} from "./finance.ts";
import { NAME_SUFFIXES } from "./dossier.ts";
import { MEASURE_SECTIONS, SECTIONS } from "./template.ts";
import type { Fact, PriorityResult, SectionResult } from "./types.ts";

/** One verified fact, where it sits on its page. */
export interface PlacedFact {
  fact: Fact;
  /** The candidate's name, or "" for a measure. */
  subject: string;
  /** The candidate's index in the race, or 0 for a measure. */
  index: number;
  /** A section id, "priority_N", or "vote_yes" / "vote_no". */
  section: string;
  /** What the page calls that place. */
  title: string;
}

/** A fact that names another item: which of its names it matched. */
export interface Mention extends PlacedFact {
  /** The candidate's name as on the ballot, or the measure's label. */
  names: string;
}

export interface OnBallotItem {
  /** The other item's position among the compared items, in ballot order. */
  at: number;
  heading: string;
  runId: string;
  /** Its candidates' names in ballot order, for anchors on its page; null for a measure. */
  candidates: string[] | null;
  /** This item's facts that name it. */
  named: Mention[];
  /** Its facts that name this item. */
  namedBy: Mention[];
}

export interface OnBallot {
  /** Other items a fact names, either way, in ballot order. */
  items: OnBallotItem[];
  /**
   * Entities tied to this item and to another, each with all its holders
   * on the ballot (ballot order), alphabetical: one entry per entity, not one
   * per item it shares.
   */
  groups: BallotShared[];
  /** Near misses (one loose name kept as separate entities) that include this item. */
  possible: BallotConnections["possible"];
  /** This item's candidates' names in ballot order; null for a measure. */
  candidates: string[] | null;
  /** Other items compared (done research). */
  compared: number;
  /** The ballot-wide matching, for its caveats. */
  connections: BallotConnections;
}

/** Every verified fact an item shows, once, in page order. */
export function placedFacts(it: BallotItemDossier): PlacedFact[] {
  const out: PlacedFact[] = [];
  const seen = new Set<string>();
  const add = (fact: Fact, subject: string, index: number, section: string, title: string) => {
    const k = `${index}\n${fact.source_url}\n${fact.statement.trim().toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ fact, subject, index, section, title });
  };
  const fromSubject = (
    subject: string,
    index: number,
    priorities: readonly PriorityResult[] | undefined,
    sections: Record<string, SectionResult | undefined>,
    template: readonly { id: string; title: string }[],
  ) => {
    (priorities ?? []).forEach((p, i) => {
      for (const f of p.result.facts) add(f, subject, index, `priority_${i + 1}`, p.issue);
    });
    for (const s of template) {
      for (const f of sections[s.id]?.facts ?? []) add(f, subject, index, s.id, s.title);
    }
  };
  if (it.measure) {
    const m = it.measure;
    if (m.status !== "ok") return out;
    if (m.vote_means?.yes) add(m.vote_means.yes, "", 0, "vote_yes", "What a YES vote means");
    if (m.vote_means?.no) add(m.vote_means.no, "", 0, "vote_no", "What a NO vote means");
    fromSubject("", 0, m.priorities, m.sections, MEASURE_SECTIONS);
  } else if (it.race) {
    it.race.candidates.forEach((c, i) => {
      if (c.status === "ok") {
        fromSubject(c.candidate.name, i, c.priorities, c.sections, SECTIONS);
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching names in text
// ---------------------------------------------------------------------------

const KEYWORD = String
  .raw`(?:[Pp]rop(?:osition)?s?\.?|PROP(?:OSITION)?S?\.?|[Mm]easures?|MEASURES?)`;
/**
 * An item id in a list, of the same shape as the label's: a number with an
 * optional letter, or a one- or two-letter local measure. Never mixed, so
 * "Prop 50 and I" doesn't name Measure I.
 */
const NUM_ID = String.raw`\d+[A-Z]?`;
const LETTER_ID = String.raw`[A-Z]{1,2}`;
const SEP = String.raw`(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|&)\s+|\s*\/\s*)`;

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pattern for a measure's label as facts write it. "Proposition 40"
 * also matches "Prop. 40", "Props 41 and 40", and "Yes on 40"; a label of
 * another shape matches only as written, whole-word.
 */
export function measurePattern(label: string): RegExp {
  const m = /^\s*(?:Prop(?:osition)?\.?|Measure)\s+(\d+[A-Z]?|[A-Z]{1,2})\s*$/i.exec(label);
  if (!m) return new RegExp(`(?<![\\p{L}\\p{N}])${escRe(label.trim())}(?![\\p{L}\\p{N}])`, "iu");
  const id = escRe(m[1].toUpperCase());
  const other = /^\d/.test(id) ? NUM_ID : LETTER_ID;
  const list = `(?:${other}${SEP})*${id}(?![\\p{L}\\p{N}])`;
  return new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${KEYWORD}\\s+(?:No\\.\\s*)?${list}|(?:[Yy]es|[Nn]o|YES|NO)\\s+on\\s+(?:${KEYWORD}\\s+)?${list})`,
    "u",
  );
}

const fold = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']s$/, "");

/** Surname particles: part of the surname, never a given name ("Kevin de León"). */
const PARTICLES = new Set([
  "de",
  "del",
  "della",
  "la",
  "las",
  "los",
  "le",
  "da",
  "das",
  "do",
  "dos",
  "di",
  "du",
  "van",
  "von",
  "der",
  "den",
  "ter",
  "y",
  "st",
  "bin",
  "ibn",
  "al",
  "el",
]);

/** A ballot name's given names (with any quoted nickname) and its surname, folded. */
export function nameParts(name: string): { given: Set<string>; surname: string } | null {
  const words = name.replace(/["“”]/g, " ").split(/[\s,]+/).map((w) => fold(w.replace(/\.$/, "")))
    .filter((w) => w && !NAME_SUFFIXES.has(w));
  if (words.length < 2) return null;
  const surname = words[words.length - 1];
  const given = new Set(words.slice(0, -1).filter((w) => w.length > 1 && !PARTICLES.has(w)));
  return given.size ? { given, surname } : null;
}

/**
 * Whether text names this person: one of the given names, then the surname,
 * with at most two capitalized words or initials between ("Victor Hugo
 * Rodriguez", "Alex Vara", "Joe A. Alvanez"), and surname particles
 * ("Kevin de León"). A surname alone never counts: on a ballot with
 * "Germaine Key", "key" is a common word. Nor does a given name across a
 * comma or a sentence's end ("Mary Brown, Jose Lopez" doesn't name Mary Lopez).
 */
export function namesPerson(text: string, parts: { given: Set<string>; surname: string }): boolean {
  const words = [...text.matchAll(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu)];
  // Whether a name can't run on from word k to word k + 1.
  const broken = (k: number) => {
    const w = words[k][0];
    const end = words[k].index! + w.length;
    const gap = text.slice(end, words[k + 1].index!);
    return /[,;:!?()[\]\/|]/.test(gap) || (w.endsWith(".") && w.replace(/\.$/, "").length > 1);
  };
  for (let i = 1; i < words.length; i++) {
    if (fold(words[i][0].replace(/\.$/, "")) !== parts.surname) continue;
    for (let j = i - 1, between = 0; j >= 0; j--) {
      if (broken(j)) break;
      const w = words[j][0];
      const f = fold(w.replace(/\.$/, ""));
      if (parts.given.has(f)) return true;
      if (PARTICLES.has(f)) continue;
      // Only a middle name or an initial may come between, at most two.
      if (!/^\p{Lu}/u.test(w) || ++between > 2) break;
    }
  }
  return false;
}

/** What names an item: its label for a measure, each candidate's name for a race. */
type Matcher = { names: string; test: (s: string) => boolean };

function matchersOf(it: BallotItemDossier): Matcher[] {
  if (it.measure) {
    const re = measurePattern(it.measure.query.label);
    return [{ names: it.measure.query.label, test: (s) => re.test(s) }];
  }
  return (it.race?.candidates ?? []).flatMap((c) => {
    const parts = nameParts(c.candidate.name);
    return parts ? [{ names: c.candidate.name, test: (s: string) => namesPerson(s, parts) }] : [];
  });
}

/** The facts of `from` that name `to`, each with the names it matched. */
export function mentions(
  from: readonly PlacedFact[],
  to: BallotItemDossier,
  ms: Matcher[] = matchersOf(to),
): Mention[] {
  return from.flatMap((p) => {
    const hit = ms.filter((m) => m.test(p.fact.statement)).map((m) => m.names);
    return hit.length ? [{ ...p, names: hit.join(", ") }] : [];
  });
}

/**
 * How the item at `here` connects to every other compared item. `items` are
 * the ballot's items with finished research, in ballot order.
 */
export function onBallot(items: readonly BallotItemDossier[], here: number): OnBallot {
  const connections = ballotConnections(items);
  const facts = items.map(placedFacts);
  const hereMatchers = matchersOf(items[here]);
  const out: OnBallotItem[] = [];
  items.forEach((other, at) => {
    if (at === here) return;
    const named = mentions(facts[here], other);
    const namedBy = mentions(facts[at], items[here], hereMatchers);
    if (named.length || namedBy.length) {
      out.push({
        at,
        heading: other.heading,
        runId: other.runId,
        candidates: candidatesOf(other),
        named,
        namedBy,
      });
    }
  });
  const groups = connections.shared.filter((s) => s.holders.some((h) => h.at === here));
  return {
    items: out,
    groups,
    possible: connections.possible.filter((g) => g.some((x) => x.at === here)),
    candidates: candidatesOf(items[here]),
    compared: items.length - 1,
    connections,
  };
}

function candidatesOf(it: BallotItemDossier): string[] | null {
  return it.measure ? null : (it.race?.candidates ?? []).map((c) => c.candidate.name);
}
