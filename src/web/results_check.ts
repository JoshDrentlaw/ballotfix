/**
 * Reads election results for read ballots (src/results.ts): on a schedule
 * while the count is open (from election day until a week after the state
 * certifies), and when the voter asks. No model; GETs to the Secretary of
 * State's feed and the county's results page only, sending nothing about the
 * voter. One check at a time; a voter's "check now" is held to one per
 * MIN_MANUAL_MS per ballot, and the schedule to one per SCHEDULE_MS.
 */

import { checkResults, type Fetcher, inCountWindow } from "../results.ts";
import type { BallotStore, ResultStore, StoredCheck, StoredResult } from "./store.ts";

/** How often the schedule reads each ballot's results while its count is open. */
export const SCHEDULE_MS = 24 * 60 * 60 * 1000;
/** How often the schedule looks for ballots due a check. */
export const TICK_MS = 60 * 60 * 1000;
/** The least time between two checks of one ballot a voter asks for. */
export const MIN_MANUAL_MS = 5 * 60 * 1000;

export type CheckOutcome =
  | { ok: true; changed: number; matched: number; errors: number }
  | { ok: false; why: string; limited?: boolean };

export class ResultsChecker {
  #busy: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #first: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly ballots: BallotStore,
    readonly store: ResultStore,
    readonly fetcher: Fetcher,
    readonly log: (msg: string) => void = () => {},
    readonly now: () => Date = () => new Date(),
  ) {}

  forBallot(id: string): Map<string, StoredResult[]> {
    return this.store.forBallot(id);
  }

  lastCheck(id: string): StoredCheck | null {
    return this.store.lastCheck(id);
  }

  /** When a voter may next ask for a check of this ballot; null when now. */
  nextManual(id: string): Date | null {
    const last = this.store.lastCheck(id);
    if (!last) return null;
    const at = new Date(last.checked_at).getTime() + MIN_MANUAL_MS;
    return at > this.now().getTime() ? new Date(at) : null;
  }

  /** Checks one ballot now, after any check already running. */
  check(id: string, manual = false): Promise<CheckOutcome> {
    const run = this.#busy.then(() => this.#check(id, manual));
    this.#busy = run.catch(() => {});
    return run;
  }

  async #check(id: string, manual: boolean): Promise<CheckOutcome> {
    const b = await this.ballots.get(id);
    if (!b?.reading) return { ok: false, why: "This ballot hasn't been read." };
    if (manual && this.nextManual(id)) {
      return {
        ok: false,
        why: "Results were just checked. Try again in a few minutes.",
        limited: true,
      };
    }
    try {
      const c = await checkResults(b.reading, this.fetcher, this.now());
      const changed = this.store.record(id, c);
      this.log(
        `[results] ${id}: ${c.matched.length} matched, ${c.unmatched.length} unmatched, ${changed} changed, ${c.errors.length} source error(s)`,
      );
      for (const e of c.errors) this.log(`[results] ${e.source} ${e.url}: ${e.why}`);
      return { ok: true, changed, matched: c.matched.length, errors: c.errors.length };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log(`[results] ${id}: check failed: ${why}`);
      return { ok: false, why: `The check failed: ${why}` };
    }
  }

  /** Every read ballot in its count window whose last check is older than SCHEDULE_MS. */
  async due(): Promise<string[]> {
    const now = this.now();
    const out: string[] = [];
    for (const b of await this.ballots.list()) {
      if (!b.reading || !inCountWindow(b.reading, now)) continue;
      const last = this.store.lastCheck(b.id);
      // A little early is fine: the tick is hourly, so a day's check doesn't drift later.
      if (last && now.getTime() - new Date(last.checked_at).getTime() < SCHEDULE_MS - TICK_MS) {
        continue;
      }
      out.push(b.id);
    }
    return out;
  }

  async tick(): Promise<void> {
    for (const id of await this.due()) await this.check(id);
  }

  /** Starts the schedule: a first look shortly after start, then every TICK_MS. */
  start(firstAfterMs = 60_000): void {
    if (this.#timer !== undefined) return;
    const go = () => this.tick().catch((err) => this.log(`[results] schedule: ${err}`));
    this.#first = setTimeout(go, firstAfterMs);
    this.#timer = setInterval(go, TICK_MS);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#first !== undefined) clearTimeout(this.#first);
    this.#timer = this.#first = undefined;
  }
}
