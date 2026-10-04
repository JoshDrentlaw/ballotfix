/**
 * Background research jobs for the web app. Races run one at a time (each
 * already researches a few candidates in parallel), which keeps API spend
 * predictable and avoids rate limits. A small queue holds the rest.
 */

import { runRace } from "../race.ts";
import { slug } from "../render.ts";
import type { BallotCandidate, RaceQuery, ResearchPort } from "../types.ts";
import type { RunRecord, RunStore } from "./store.ts";

export interface JobRunnerOptions {
  /** Candidates researched in parallel within one race. */
  concurrency?: number;
  /** Races allowed to wait behind the running one. */
  maxQueued?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class QueueFullError extends Error {}

export class JobRunner {
  readonly #store: RunStore;
  readonly #makePort: () => ResearchPort;
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #now: () => Date;
  readonly #log: (msg: string) => void;
  #tail: Promise<void> = Promise.resolve();
  #waiting = 0;

  constructor(store: RunStore, makePort: () => ResearchPort, opts: JobRunnerOptions = {}) {
    this.#store = store;
    this.#makePort = makePort;
    this.#concurrency = opts.concurrency ?? 3;
    this.#maxQueued = opts.maxQueued ?? 3;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? (() => {});
  }

  /** Races waiting or running. */
  get pending(): number {
    return this.#waiting;
  }

  #newId(q: RaceQuery): string {
    const stamp = this.#now().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const rand = crypto.getRandomValues(new Uint8Array(3));
    const suffix = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${slug(`${q.city}-${q.office}-${q.electionDate}`).slice(0, 90)}-${stamp}-${suffix}`;
  }

  async submit(query: RaceQuery, candidates: BallotCandidate[] | null): Promise<RunRecord> {
    // One running plus maxQueued waiting.
    if (this.#waiting > this.#maxQueued) {
      throw new QueueFullError(
        `${this.#waiting} races are already waiting. Try again when one finishes.`,
      );
    }
    const at = this.#now().toISOString();
    const run: RunRecord = {
      id: this.#newId(query),
      query,
      candidates,
      status: "queued",
      created_at: at,
      updated_at: at,
      error: null,
      race: null,
    };
    await this.#store.save(run);
    this.#waiting++;
    this.#tail = this.#tail.then(() => this.#execute(run)).finally(() => {
      this.#waiting--;
    });
    return run;
  }

  /** Resolves once every submitted race has finished. For tests and shutdown. */
  idle(): Promise<void> {
    return this.#tail;
  }

  async #execute(initial: RunRecord): Promise<void> {
    let run: RunRecord = { ...initial, status: "running", updated_at: this.#now().toISOString() };
    const save = async (patch: Partial<RunRecord>) => {
      run = { ...run, ...patch, updated_at: this.#now().toISOString() };
      await this.#store.save(run);
    };
    try {
      await save({});
      const race = await runRace(run.query, this.#makePort(), {
        candidates: run.candidates ?? undefined,
        concurrency: this.#concurrency,
        onProgress: (m) => this.#log(`[${run.id}] ${m}`),
        onUpdate: (partial) => save({ race: partial }),
      });
      await save({ race, status: "done" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log(`[${run.id}] failed: ${msg}`);
      try {
        await save({ status: "failed", error: msg });
      } catch (saveErr) {
        this.#log(`[${run.id}] could not record failure: ${saveErr}`);
      }
    }
  }
}
