/** Orchestrates one race: ballot, then every candidate, then assembly. */

import { assembleCandidate, failedCandidate, pendingCandidate, STANDING_GAPS } from "./dossier.ts";
import type {
  BallotCandidate,
  BallotListing,
  CandidateDossier,
  RaceDossier,
  RaceQuery,
  ResearchPort,
} from "./types.ts";

export interface RunRaceOptions {
  /** Skip ballot discovery and use this list, in this order. */
  candidates?: BallotCandidate[];
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
      source_name: "Candidate list supplied by the user",
      source_url: null,
      order_basis: "unofficial",
      notes:
        "Ballot discovery was skipped. Order is as supplied, not verified against an official source.",
      retrieved_urls: [],
    };
  } else {
    log(`Finding the ${query.office} race in ${query.city}, ${query.state}...`);
    listing = await port.findBallot(query);
    log(`Found ${listing.candidates.length} candidates (${listing.source_name}).`);
  }

  const now = opts.now ?? (() => new Date());
  const snapshot = (candidates: CandidateDossier[]): RaceDossier => ({
    query,
    listing,
    candidates: [...candidates],
    standing_gaps: [...STANDING_GAPS],
    generated_at: now().toISOString(),
  });
  const current = listing.candidates.map(pendingCandidate);
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

  await mapLimit(listing.candidates, opts.concurrency ?? 3, async (c, i) => {
    log(`Researching ${c.name}...`);
    try {
      const raw = await port.researchCandidate(query, c, listing);
      current[i] = assembleCandidate(c, raw);
      log(`Done: ${c.name}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed: ${c.name}: ${msg}`);
      current[i] = failedCandidate(c, msg);
    }
    await emit();
  });

  return snapshot(current);
}
