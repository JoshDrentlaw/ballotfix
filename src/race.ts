/** Orchestrates one race (ballot, then every candidate, then assembly) or one measure. */

import {
  assembleCandidate,
  assembleMeasure,
  failedCandidate,
  failureEffort,
  pendingCandidate,
  placeholderMeasure,
  STANDING_GAPS,
} from "./dossier.ts";
import { findShared, type SharedPass, withShared } from "./shared.ts";
import type {
  BallotCandidate,
  BallotListing,
  CandidateDossier,
  CandidateSource,
  MeasureDossier,
  MeasureQuery,
  RaceDossier,
  RaceQuery,
  ResearchPort,
  SharedSourceFinder,
  SharedSources,
} from "./types.ts";

export interface RunRaceOptions {
  /** Skip ballot discovery and use this list, in this order. */
  candidates?: BallotCandidate[];
  /** Where `candidates` came from. Defaults to "supplied by the user", unofficial order. */
  candidateSource?: CandidateSource;
  /** Issues the voter said matter most; asked about identically for every candidate. */
  priorities?: readonly string[];
  /**
   * Finds pages covering every candidate, once, before any candidate's
   * research (src/shared.ts). Absent: no shared pass, and the race says nothing of one.
   */
  shared?: SharedSourceFinder;
  /** A shared pass already made, given to every candidate as it is, in place of `shared`. */
  sharedPass?: SharedPass;
  concurrency?: number;
  onProgress?: (msg: string) => void;
  /**
   * Called with a partial dossier once the ballot is known and again after
   * each candidate finishes. Candidates not yet done have status "pending".
   */
  onUpdate?: (partial: RaceDossier) => void | Promise<void>;
  now?: () => Date;
}

/** Map with bounded concurrency, preserving input order in the output. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export async function runRace(
  query: RaceQuery,
  port: ResearchPort,
  opts: RunRaceOptions = {},
): Promise<RaceDossier> {
  const log = opts.onProgress ?? (() => {});
  let listing: BallotListing;
  if (opts.candidates?.length) {
    listing = {
      candidates: opts.candidates,
      ...(opts.candidateSource ?? {
        source_name: "Candidate list supplied by the user",
        order_basis: "unofficial",
        notes:
          "Ballot discovery was skipped. Order is as supplied, not verified against an official source.",
      }),
      source_url: null,
      retrieved_urls: [],
    };
  } else {
    log(`Finding the ${query.office} race in ${query.city}, ${query.state}...`);
    listing = await port.findBallot(query);
    log(`Found ${listing.candidates.length} candidates (${listing.source_name}).`);
  }

  const now = opts.now ?? (() => new Date());
  const priorities = [...(opts.priorities ?? [])];
  let shared: SharedSources | undefined;
  const snapshot = (candidates: CandidateDossier[]): RaceDossier => ({
    query,
    listing,
    priorities,
    candidates: [...candidates],
    standing_gaps: [...STANDING_GAPS],
    generated_at: now().toISOString(),
    ...(shared ? { shared } : {}),
  });
  const current = listing.candidates.map((c) => pendingCandidate(c, priorities));
  // Updates are chained so a slow save can't land after a newer one.
  let updates: Promise<void> = Promise.resolve();
  const emit = () => {
    const snap = snapshot(current);
    updates = updates.then(() => opts.onUpdate?.(snap)).catch((err) => {
      // A failed save must not stop the research; the final result is still returned.
      log(`Saving progress failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return updates;
  };
  await emit();

  let pass = opts.sharedPass;
  if (!pass && opts.shared && listing.candidates.length) {
    log("Looking for pages that cover every candidate...");
    pass = await findShared(query, listing.candidates, opts.shared, now());
    if (pass.result.error) log(`Shared pass failed: ${pass.result.error}`);
    else if (!pass.result.skipped) log(`Shared pages kept: ${pass.pages.length}.`);
  }
  const sharedPages = pass?.pages ?? [];
  if (pass) {
    shared = pass.result;
    await emit();
  }

  await mapLimit(listing.candidates, opts.concurrency ?? 3, async (c, i) => {
    log(`Researching ${c.name}...`);
    try {
      const raw = await port.researchCandidate(query, c, listing, priorities, sharedPages);
      current[i] = assembleCandidate(c, withShared(raw, sharedPages), priorities);
      log(`Done: ${c.name}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed: ${c.name}: ${msg}`);
      current[i] = failedCandidate(c, msg, priorities, failureEffort(err));
    }
    await emit();
  });

  return snapshot(current);
}

export interface RunMeasureOptions {
  priorities?: readonly string[];
  onProgress?: (msg: string) => void;
  /** Called once with the pending placeholder, before research starts. */
  onUpdate?: (partial: MeasureDossier) => void | Promise<void>;
  now?: () => Date;
}

/** One research session for one measure. A failure still returns the full template. */
export async function runMeasure(
  query: MeasureQuery,
  port: ResearchPort,
  opts: RunMeasureOptions = {},
): Promise<MeasureDossier> {
  const log = opts.onProgress ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const priorities = [...(opts.priorities ?? [])];
  await opts.onUpdate?.(placeholderMeasure(query, priorities, now(), null));
  log(`Researching ${query.label} (${query.jurisdiction})...`);
  try {
    const raw = await port.researchMeasure(query, priorities);
    log(`Done: ${query.label}.`);
    return assembleMeasure(query, raw, priorities, now());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed: ${query.label}: ${msg}`);
    return placeholderMeasure(query, priorities, now(), msg, failureEffort(err));
  }
}
