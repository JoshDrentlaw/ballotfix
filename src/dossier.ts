/**
 * Turns unvalidated research into a dossier that obeys the invariants.
 *
 * - Every section in the template is present, for every candidate, in order.
 * - A section with no facts always carries a gap note.
 * - A fact is shown as verified only if its URL is one the research session
 *   actually retrieved. Everything else goes to `unverified`, never dropped
 *   silently and never mixed in.
 * - Unknown evidence types collapse to "unsourced", the least trusted tag.
 */

import {
  MAX_PRIORITIES_PER_LIST,
  MAX_PRIORITY_LENGTH,
  MEASURE_SECTION_IDS,
  MEASURE_SECTIONS,
  priorityId,
  SECTION_IDS,
  SECTIONS,
} from "./template.ts";
import {
  type BallotCandidate,
  type BallotListing,
  type BallotMeasure,
  type BallotReading,
  type CandidateDossier,
  EVIDENCE_TYPES,
  type EvidenceType,
  type Fact,
  type MeasureDossier,
  type MeasureQuery,
  type MeasureSectionId,
  type PriorityResult,
  type RawCandidateResearch,
  type RawFact,
  type RawMeasureResearch,
  type RawSection,
  type RawStance,
  type SectionId,
  type SectionResult,
  type Stance,
  STANCES,
} from "./types.ts";

/** Phase 0's permanent blind spots. Shown on every page, every run. */
export const STANDING_GAPS: readonly string[] = [
  "Phase 0 researches with general web search, plus one capped lookup of campaign finance filings per run. It does not read council minutes or budget documents directly, and filing portals behind a login or JavaScript can't be read, so records that search engines don't index are likely missing.",
  "Paywalled local news is usually not readable, so coverage from subscription outlets may be absent or represented only by headlines.",
  "Social media is not searched: Facebook community groups, Nextdoor, Instagram, and TikTok, where much local political discussion happens, are a blind spot.",
  "PDF records (agendas, minutes, budgets, filings) are only included when search surfaced them and they could be fetched.",
  "Absence of a finding is not evidence of absence. An empty section means this run found nothing, not that nothing exists.",
];

/** Normalize a URL for provenance matching: host case, fragment, trailing slash, tracking params. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
  }
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  const search = u.searchParams.toString();
  // http and https are treated as the same page.
  return `${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${search ? `?${search}` : ""}`;
}

function toEvidenceType(v: string): EvidenceType {
  return (EVIDENCE_TYPES as readonly string[]).includes(v) ? v as EvidenceType : "unsourced";
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

function cleanOrNull(s: unknown): string | null {
  const v = clean(s);
  return v ? v : null;
}

function toFact(raw: RawFact): Fact | null {
  const statement = clean(raw.statement);
  const source_url = clean(raw.source_url);
  if (!statement || normalizeUrl(source_url) === null) return null;
  return {
    statement,
    source_name: clean(raw.source_name) || "source name not given",
    source_url,
    author: cleanOrNull(raw.author),
    published: cleanOrNull(raw.published),
    evidence_type: toEvidenceType(clean(raw.evidence_type)),
  };
}

function emptySection(gap: string): SectionResult {
  return { facts: [], searched: [], gap_note: gap };
}

const NOTHING_FOUND = "This run found nothing it could source for this section.";

/**
 * Validates one section and runs the provenance check: facts citing a page
 * the session never retrieved are moved to `unverified`.
 */
function assembleSection(
  rs: RawSection | undefined,
  retrieved: ReadonlySet<string>,
  unverified: Fact[],
  emptyNote: string,
): SectionResult {
  const facts: Fact[] = [];
  for (const rf of rs?.facts ?? []) {
    const f = toFact(rf);
    if (!f) continue;
    if (retrieved.has(normalizeUrl(f.source_url)!)) facts.push(f);
    else unverified.push(f);
  }
  const searched = (rs?.searched ?? []).map(clean).filter(Boolean);
  const gap_note = cleanOrNull(rs?.gap_note) ?? (facts.length ? null : emptyNote);
  return { facts, searched, gap_note };
}

function retrievedSet(urls: readonly string[]): Set<string> {
  return new Set(urls.map(normalizeUrl).filter((u): u is string => u !== null));
}

/**
 * The voter's issues, each as its own section, in their order. A stance
 * other than "no_position" stands only on verified facts: with none, it is
 * "unclear", whatever the researcher said.
 */
function assemblePriorities(
  issues: readonly string[],
  raw: {
    sections: Record<string, RawSection | undefined>;
    stances?: Record<string, RawStance | undefined>;
  },
  retrieved: ReadonlySet<string>,
  unverified: Fact[],
): PriorityResult[] {
  return issues.map((issue, i) => {
    const id = priorityId(i);
    const result = assembleSection(raw.sections[id], retrieved, unverified, NOTHING_FOUND);
    const rs = raw.stances?.[id];
    let stance: Stance = rs && (STANCES as readonly string[]).includes(rs.stance)
      ? rs.stance as Stance
      : "unclear";
    let stance_basis = cleanOrNull(rs?.basis);
    const usable = result.facts.filter((f) => f.evidence_type !== "unsourced");
    if (stance !== "no_position" && stance !== "unclear") {
      if (usable.length === 0) {
        stance = "unclear";
        stance_basis = "No verified source in this run supports a stance on this.";
      } else if (usable.every((f) => f.evidence_type === "opinion")) {
        // Candidates' own statements count, but say so: no record or reporting backs it.
        stance_basis = `${
          stance_basis ? `${stance_basis} ` : ""
        }(Rests only on statements, endorsements, or advocacy, not records or reporting.)`;
      }
    }
    return { issue, result, stance, stance_basis };
  });
}

/** Same placeholder for every issue, for failed and pending results. */
function placeholderPriorities(issues: readonly string[], note: string): PriorityResult[] {
  return issues.map((issue) => ({ issue, result: emptySection(note) }));
}

export function assembleCandidate(
  candidate: BallotCandidate,
  raw: RawCandidateResearch,
  priorities: readonly string[] = [],
): CandidateDossier {
  const retrieved = retrievedSet(raw.retrieved_urls);
  const unverified: Fact[] = [];
  const sections = {} as Record<SectionId, SectionResult>;

  for (const spec of SECTIONS) {
    sections[spec.id] = assembleSection(
      raw.sections[spec.id],
      retrieved,
      unverified,
      "incumbentOnly" in spec && spec.incumbentOnly && !candidate.incumbent
        ? "Not the incumbent in this office, so there is no record in it to report."
        : NOTHING_FOUND,
    );
  }

  return {
    candidate,
    status: "ok",
    sections,
    unverified,
    identity_note: cleanOrNull(raw.identity_note),
    priorities: assemblePriorities(priorities, raw, retrieved, unverified),
    gaps: raw.gaps.map(clean).filter(Boolean),
    model: raw.model,
    error: null,
  };
}

/** A failed candidate still gets the full template, so the page never silently drops anyone. */
export function failedCandidate(
  candidate: BallotCandidate,
  error: string,
  priorities: readonly string[] = [],
): CandidateDossier {
  const note = "Research for this candidate failed in this run; nothing was checked.";
  const sections = {} as Record<SectionId, SectionResult>;
  for (const id of SECTION_IDS) sections[id] = emptySection(note);
  return {
    candidate,
    status: "failed",
    sections,
    unverified: [],
    identity_note: null,
    priorities: placeholderPriorities(priorities, note),
    gaps: [`Research failed: ${error}`],
    model: null,
    error,
  };
}

/** Placeholder for a candidate still being researched; replaced when their research finishes. */
export function pendingCandidate(
  candidate: BallotCandidate,
  priorities: readonly string[] = [],
): CandidateDossier {
  const sections = {} as Record<SectionId, SectionResult>;
  for (const id of SECTION_IDS) sections[id] = emptySection("Still researching.");
  return {
    candidate,
    status: "pending",
    sections,
    unverified: [],
    identity_note: null,
    priorities: placeholderPriorities(priorities, "Still researching."),
    gaps: [],
    model: null,
    error: null,
  };
}

/** Sections with at least one verified fact. Drives the overview's coverage line. */
export function coveredSections(d: CandidateDossier): number {
  // Runs saved before a section existed don't have it; they count it as not covered.
  return SECTION_IDS.filter((id) => (d.sections[id]?.facts.length ?? 0) > 0).length;
}

export function assembleMeasure(
  query: MeasureQuery,
  raw: RawMeasureResearch,
  priorities: readonly string[],
  now: Date,
): MeasureDossier {
  const retrieved = retrievedSet(raw.retrieved_urls);
  const unverified: Fact[] = [];
  const sections = {} as Record<MeasureSectionId, SectionResult>;
  for (const spec of MEASURE_SECTIONS) {
    sections[spec.id] = assembleSection(
      raw.sections[spec.id],
      retrieved,
      unverified,
      NOTHING_FOUND,
    );
  }
  return {
    query,
    status: "ok",
    official_title: cleanOrNull(raw.official_title),
    sections,
    priorities: assemblePriorities(priorities, raw, retrieved, unverified),
    priority_issues: [...priorities],
    unverified,
    identity_note: cleanOrNull(raw.identity_note),
    gaps: raw.gaps.map(clean).filter(Boolean),
    standing_gaps: [...STANDING_GAPS],
    model: raw.model,
    error: null,
    generated_at: now.toISOString(),
  };
}

/** A measure whose research failed or hasn't finished still shows the whole template. */
export function placeholderMeasure(
  query: MeasureQuery,
  priorities: readonly string[],
  now: Date,
  error: string | null,
): MeasureDossier {
  const note = error
    ? "Research for this measure failed in this run; nothing was checked."
    : "Still researching.";
  const sections = {} as Record<MeasureSectionId, SectionResult>;
  for (const id of MEASURE_SECTION_IDS) sections[id] = emptySection(note);
  return {
    query,
    status: error ? "failed" : "pending",
    official_title: null,
    sections,
    priorities: placeholderPriorities(priorities, note),
    priority_issues: [...priorities],
    unverified: [],
    identity_note: null,
    gaps: error ? [`Research failed: ${error}`] : [],
    standing_gaps: [...STANDING_GAPS],
    model: null,
    error,
    generated_at: now.toISOString(),
  };
}

/**
 * The yes/no items on a reading. Readings saved before measures were
 * researched hold bare strings; those come back as measures with the string
 * as their label, since there is no telling them apart from retention reliably.
 */
export function measuresOf(r: BallotReading): BallotMeasure[] {
  return r.measures.map((m) =>
    typeof m === "string"
      ? { kind: "measure", label: m, jurisdiction: "", question: "", person: "" }
      : m
  );
}

/**
 * Election invariant 2: incumbency asymmetry is disclosed, not hidden. Returns
 * the note to show on the race overview, or null when nobody is an incumbent.
 */
export function incumbencyNote(listing: BallotListing): string | null {
  if (listing.contest_kind === "retention") {
    const names = listing.candidates.map((c) => c.name).join(" and ");
    return `This is a yes/no retention question: voters decide whether ${
      names || "the judge"
    } keeps the seat, so there is no opponent to compare with. Judicial conduct rules limit what judges can say about issues, so a short platform section is expected.`;
  }
  const incumbents = listing.candidates.filter((c) => c.incumbent).map((c) => c.name);
  if (incumbents.length === 0) return null;
  return `${incumbents.join(" and ")} ${
    incumbents.length === 1 ? "holds" : "hold"
  } this office now, so there is a public record in it to research. Challengers usually have far less. A shorter dossier is not a cleaner one, and a longer one is not a worse one.`;
}

/**
 * The optional "what matters most to you" list: one issue per line (or
 * semicolon). Each becomes the same extra question for every candidate.
 */
export function parsePriorities(text: string): { ok: true; issues: string[] } | {
  ok: false;
  error: string;
} {
  const issues = text.split(/[\n;]/)
    // deno-lint-ignore no-control-regex
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (issues.length > MAX_PRIORITIES_PER_LIST) {
    return {
      ok: false,
      error: `Name up to ${MAX_PRIORITIES_PER_LIST} issues that matter most to you in each list.`,
    };
  }
  if (issues.some((s) => s.length > MAX_PRIORITY_LENGTH)) {
    return {
      ok: false,
      error: `Keep each issue to ${MAX_PRIORITY_LENGTH} characters, like "housing costs".`,
    };
  }
  const seen = new Set<string>();
  return {
    ok: true,
    issues: issues.filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())),
  };
}
