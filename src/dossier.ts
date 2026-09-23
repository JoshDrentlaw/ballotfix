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

import { SECTION_IDS, SECTIONS } from "./template.ts";
import {
  type BallotCandidate,
  type BallotListing,
  type CandidateDossier,
  EVIDENCE_TYPES,
  type EvidenceType,
  type Fact,
  type RawCandidateResearch,
  type RawFact,
  type SectionId,
  type SectionResult,
} from "./types.ts";

/** Phase 0's permanent blind spots. Shown on every page, every run. */
export const STANDING_GAPS: readonly string[] = [
  "Phase 0 researches with general web search only. It does not yet read campaign finance portals, council minutes, or budget documents directly, so records that search engines don't index are likely missing.",
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

export function assembleCandidate(
  candidate: BallotCandidate,
  raw: RawCandidateResearch,
): CandidateDossier {
  const retrieved = new Set(
    raw.retrieved_urls.map(normalizeUrl).filter((u): u is string => u !== null),
  );
  const unverified: Fact[] = [];
  const sections = {} as Record<SectionId, SectionResult>;

  for (const spec of SECTIONS) {
    const rs = raw.sections[spec.id];
    const facts: Fact[] = [];
    for (const rf of rs?.facts ?? []) {
      const f = toFact(rf);
      if (!f) continue;
      if (retrieved.has(normalizeUrl(f.source_url)!)) facts.push(f);
      else unverified.push(f);
    }
    const searched = (rs?.searched ?? []).map(clean).filter(Boolean);
    let gap_note = cleanOrNull(rs?.gap_note);
    if (facts.length === 0 && !gap_note) {
      gap_note = "incumbentOnly" in spec && spec.incumbentOnly && !candidate.incumbent
        ? "Not the incumbent in this office, so there is no record in it to report."
        : "This run found nothing it could source for this section.";
    }
    sections[spec.id] = { facts, searched, gap_note };
  }

  return {
    candidate,
    status: "ok",
    sections,
    unverified,
    identity_note: cleanOrNull(raw.identity_note),
    gaps: raw.gaps.map(clean).filter(Boolean),
    model: raw.model,
    error: null,
  };
}

/** A failed candidate still gets the full template, so the page never silently drops anyone. */
export function failedCandidate(candidate: BallotCandidate, error: string): CandidateDossier {
  const sections = {} as Record<SectionId, SectionResult>;
  for (const id of SECTION_IDS) {
    sections[id] = emptySection(
      "Research for this candidate failed in this run; nothing was checked.",
    );
  }
  return {
    candidate,
    status: "failed",
    sections,
    unverified: [],
    identity_note: null,
    gaps: [`Research failed: ${error}`],
    model: null,
    error,
  };
}

/** Sections with at least one verified fact. Drives the overview's coverage line. */
export function coveredSections(d: CandidateDossier): number {
  return SECTION_IDS.filter((id) => d.sections[id].facts.length > 0).length;
}

/**
 * Election invariant 2: incumbency asymmetry is disclosed, not hidden. Returns
 * the note to show on the race overview, or null when nobody is an incumbent.
 */
export function incumbencyNote(listing: BallotListing): string | null {
  const incumbents = listing.candidates.filter((c) => c.incumbent).map((c) => c.name);
  if (incumbents.length === 0) return null;
  return `${incumbents.join(" and ")} ${
    incumbents.length === 1 ? "holds" : "hold"
  } this office now, so there is a public record in it to research. Challengers usually have far less. A shorter dossier is not a cleaner one, and a longer one is not a worse one.`;
}
