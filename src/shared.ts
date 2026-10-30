/**
 * The shared race-level pass: one capped call per race, before any
 * candidate's research, for pages that cover every candidate at once (the
 * county voter guide's statements, a local outlet's questionnaire, forum
 * write-ups, Voter's Edge). Kept pages go first in every candidate's prompt,
 * in the same words, so every candidate starts from the same sources and the
 * prefix is cached across them.
 *
 * - A page is kept only if the pass opened it and its text, as the candidates
 *   are given it, names every candidate's surname: a page covering some of
 *   them would start the others behind. Everything else is listed as left out.
 * - Kept pages count as retrieved by each candidate's session, with their
 *   whole text for the quote check (`withShared`), since the session read
 *   them in its prompt. Search results the pass only saw are not added.
 * - A failed pass is recorded and every candidate starts without shared
 *   pages; one candidate gets no pass, since there is no one to keep level.
 */

import { candidateSubject, failureEffort, normalizeUrl, plainText } from "./dossier.ts";
import {
  type BallotCandidate,
  type RaceQuery,
  type RawCandidateResearch,
  type RawSharedSources,
  SHARED_KINDS,
  type SharedKind,
  type SharedLeftOut,
  type SharedPageText,
  type SharedSourceFinder,
  type SharedSources,
} from "./types.ts";

/** Most pages put in front of every candidate. */
export const MAX_SHARED_PAGES = 4;

/** Each page's text is cut here before it goes to the candidates; the names must fall inside. */
export const SHARED_PAGE_MAX_CHARS = 40_000;

/** Longest source name or title kept; a longer one is dropped, never cut. */
const MAX_LABEL_CHARS = 200;

export const ONE_CANDIDATE =
  "Only one candidate is in this race, so there was no shared pass to keep anyone level with.";

/** The shared pass as saved, and the pages with text for the candidates' prompts. */
export interface SharedPass {
  result: SharedSources;
  pages: SharedPageText[];
}

const label = (v: unknown): string => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length <= MAX_LABEL_CHARS ? s : "";
};

/**
 * Checks what the pass reported: each page must have been opened and read,
 * and its text as the candidates get it must name every candidate. The first
 * MAX_SHARED_PAGES that pass are kept, in the order reported.
 */
export function assembleShared(
  raw: RawSharedSources,
  candidates: readonly BallotCandidate[],
  lookedUp: string,
): SharedPass {
  const opened = new Map<string, string | null>();
  for (const p of raw.opened_pages ?? []) {
    const key = normalizeUrl(p.url);
    // A page fetched twice keeps the copy whose text can be read.
    if (key && (opened.get(key) ?? null) === null) opened.set(key, p.text);
  }
  const subjects = candidates.map((c) => ({ name: c.name, terms: candidateSubject(c).terms }));
  const pages: SharedPageText[] = [];
  const left_out: SharedLeftOut[] = [];
  const seen = new Set<string>();
  for (const p of raw.pages) {
    const url = typeof p.url === "string" ? p.url.trim() : "";
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const source_name = label(p.source_name) || key.split("/")[0];
    const out = (reason: SharedLeftOut["reason"], missing?: string[]) =>
      left_out.push({ url, source_name, reason, ...(missing ? { missing } : {}) });
    if (!opened.has(key)) {
      out("not_opened");
      continue;
    }
    const full = opened.get(key) ?? null;
    if (full === null || !full.trim()) {
      out("not_read");
      continue;
    }
    const text = full.slice(0, SHARED_PAGE_MAX_CHARS);
    const hay = plainText(text);
    const missing = subjects.filter((s) => !s.terms.some((t) => hay.includes(plainText(t))))
      .map((s) => s.name);
    if (missing.length) {
      out("missing_names", missing);
      continue;
    }
    if (pages.length >= MAX_SHARED_PAGES) {
      out("over_cap");
      continue;
    }
    const kind = (SHARED_KINDS as readonly string[]).includes(p.kind)
      ? p.kind as SharedKind
      : "other";
    pages.push({
      url,
      source_name,
      title: label(p.title) || null,
      kind,
      ...(text.length < full.length ? { cut: true } : {}),
      text,
      full_text: full,
    });
  }
  return {
    result: {
      pages: pages.map(({ text: _t, full_text: _f, ...saved }) => saved),
      left_out,
      gaps: raw.gaps.map((g) => String(g).trim()).filter(Boolean),
      model: raw.model,
      looked_up: lookedUp,
      ...(raw.effort ? { effort: raw.effort } : {}),
    },
    pages,
  };
}

/** Runs the shared pass for a race. A failure is recorded, never thrown. */
export async function findShared(
  query: RaceQuery,
  candidates: readonly BallotCandidate[],
  finder: SharedSourceFinder,
  now: Date,
): Promise<SharedPass> {
  const lookedUp = now.toISOString();
  const base = { pages: [], left_out: [], gaps: [], model: null, looked_up: lookedUp };
  if (candidates.length < 2) return { result: { ...base, skipped: ONE_CANDIDATE }, pages: [] };
  try {
    const raw = await finder.findSharedSources({
      place: `${query.city}, ${query.state}`,
      office: query.office,
      electionDate: query.electionDate,
      candidates: candidates.map((c) => c.name),
      max_pages: MAX_SHARED_PAGES,
    });
    return assembleShared(raw, candidates, lookedUp);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const effort = failureEffort(err);
    return { result: { ...base, error, ...(effort ? { effort } : {}) }, pages: [] };
  }
}

/**
 * A candidate's research with the shared pages added to what its session
 * retrieved and opened: it read them in its prompt. Their whole text goes to
 * the quote check, ahead of the session's own copies.
 */
export function withShared(
  raw: RawCandidateResearch,
  pages: readonly SharedPageText[],
): RawCandidateResearch {
  if (!pages.length) return raw;
  return {
    ...raw,
    retrieved_urls: [...pages.map((p) => p.url), ...raw.retrieved_urls],
    opened_pages: [
      ...pages.map((p) => ({ url: p.url, text: p.full_text })),
      ...(raw.opened_pages ?? []),
    ],
  };
}
