/** Orchestrates one race: ballot, then every candidate, then assembly. */

import { assembleCandidate, failedCandidate, STANDING_GAPS } from "./dossier.ts";
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

  const candidates: CandidateDossier[] = await mapLimit(
    listing.candidates,
    opts.concurrency ?? 3,
    async (c) => {
      log(`Researching ${c.name}...`);
      try {
        const raw = await port.researchCandidate(query, c, listing);
        const d = assembleCandidate(c, raw);
        log(`Done: ${c.name}.`);
        return d;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed: ${c.name}: ${msg}`);
        return failedCandidate(c, msg);
      }
    },
  );

  return {
    query,
    listing,
    candidates,
    standing_gaps: [...STANDING_GAPS],
    generated_at: (opts.now ?? (() => new Date()))().toISOString(),
  };
}
