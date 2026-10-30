/**
 * Background research jobs for the web app. Races run one at a time (each
 * already researches a few candidates in parallel), which keeps API spend
 * predictable and avoids rate limits. A small queue holds the rest.
 */

import {
  contextForMeasure,
  contextForRace,
  type KnownNotes,
  measureContextFailed,
  raceContextFailed,
} from "../context.ts";
import {
  financeForMeasure,
  financeForRace,
  measureFinanceFailed,
  raceFinanceFailed,
} from "../finance.ts";
import { mergeMeasure, mergeRace } from "../merge.ts";
import { officeForRace, raceOfficeFailed } from "../office.ts";
import { runMeasure, runRace } from "../race.ts";
import { slug } from "../render.ts";
import type {
  BallotCandidate,
  BallotPage,
  BallotReader,
  CandidateSource,
  ClaimMerger,
  ContextWriter,
  FinanceResearcher,
  MeasureDossier,
  MeasureQuery,
  OfficeResearcher,
  RaceDossier,
  RaceQuery,
  ResearchPort,
} from "../types.ts";
import type { BallotLink, BallotRecord, BallotStore, RunRecord, RunStore } from "./store.ts";

export interface JobRunnerOptions {
  /** Candidates researched in parallel within one race. */
  concurrency?: number;
  /**
   * Races allowed to wait behind the running one. They run one at a time and
   * are saved as "queued", so a restart puts them back in line (resume).
   */
  maxQueued?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /**
   * Merges duplicate claims once a run is done: one call per run, after the
   * finished run is saved, so the page doesn't wait on it. Omit to skip.
   */
  makeMerger?: () => ClaimMerger;
  /**
   * Writes context notes on the names in a done run's facts: one call per run,
   * after the merge step, then saved again. Omit to skip.
   */
  makeContextWriter?: () => ContextWriter;
  /**
   * Reads contributions off campaign finance filings: one call per run, after
   * the context step, then saved again. Omit to skip.
   */
  makeFinanceResearcher?: () => FinanceResearcher;
  /**
   * Looks up what a race's office can do, or reuses an earlier run's lookup of
   * the same office in the same place, and marks the voter's issues against
   * it: after the finance step, races only. Omit to skip.
   */
  makeOfficeResearcher?: () => OfficeResearcher;
}

/** What one finished run needs for the steps after it, race or measure. */
interface AfterSteps<T> {
  merge: (
    d: T,
    m: ClaimMerger,
  ) => Promise<{ dossier: T; groups: number; sent: number; skipped: number }>;
  context: (
    d: T,
    w: ContextWriter,
    known: KnownNotes,
  ) => Promise<{ dossier: T; sent: number; shown: number; skipped: number; reused: number }>;
  contextFailed: (d: T, error: string, known: KnownNotes) => T;
  /** Where the run is, as [state, jurisdiction]: notes are reused only within one place. */
  place: (d: T) => [string, string];
  finance: (
    d: T,
    f: FinanceResearcher,
  ) => Promise<{ dossier: T; sent: number; shown: number; left_out: number }>;
  financeFailed: (d: T, error: string) => T;
  save: (dossier: T) => Promise<void>;
}

const RACE_STEPS = {
  merge: mergeRace,
  context: contextForRace,
  contextFailed: raceContextFailed,
  finance: financeForRace,
  financeFailed: raceFinanceFailed,
  place: (d) => [d.query.state, d.query.city],
} satisfies Omit<AfterSteps<RaceDossier>, "save">;

const MEASURE_STEPS = {
  merge: mergeMeasure,
  context: contextForMeasure,
  contextFailed: measureContextFailed,
  finance: financeForMeasure,
  financeFailed: measureFinanceFailed,
  place: (d) => [d.query.state, d.query.jurisdiction],
} satisfies Omit<AfterSteps<MeasureDossier>, "save">;

/** One step that runs after a run is saved as done: what it changed, and what to log. */
interface AfterStep<T> {
  dossier: T;
  changed: boolean;
  log: string[];
}

export class QueueFullError extends Error {}

/** Enough for a whole ballot. Each waiting race costs nothing until it starts. */
export const DEFAULT_MAX_QUEUED = 30;

/**
 * A waiting race older than this when the server starts is not resumed: after
 * a long outage, research shouldn't start spending with no one there to ask.
 */
export const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000;

export interface SubmitExtras {
  /** Issues the voter said matter most; the same list for every candidate. */
  priorities?: string[];
  /** Research this measure instead of a race. */
  measure?: MeasureQuery;
  /** Keep using an earlier run's notes and pick (on rerun). Default: the new run's id. */
  choiceId?: string;
  /** The ballot item this comes from. */
  ballot?: BallotLink | null;
}

export class JobRunner {
  readonly #store: RunStore;
  readonly #makePort: () => ResearchPort;
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #now: () => Date;
  readonly #log: (msg: string) => void;
  readonly #makeMerger: (() => ClaimMerger) | undefined;
  readonly #makeContextWriter: (() => ContextWriter) | undefined;
  readonly #makeFinanceResearcher: (() => FinanceResearcher) | undefined;
  readonly #makeOfficeResearcher: (() => OfficeResearcher) | undefined;
  #tail: Promise<void> = Promise.resolve();
  #waiting = 0;
  #post = new Set<Promise<void>>();

  constructor(store: RunStore, makePort: () => ResearchPort, opts: JobRunnerOptions = {}) {
    this.#store = store;
    this.#makePort = makePort;
    this.#concurrency = opts.concurrency ?? 3;
    this.#maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? (() => {});
    this.#makeMerger = opts.makeMerger;
    this.#makeContextWriter = opts.makeContextWriter;
    this.#makeFinanceResearcher = opts.makeFinanceResearcher;
    this.#makeOfficeResearcher = opts.makeOfficeResearcher;
  }

  /**
   * Runs one step on a run already saved as done, and saves again if it
   * changed anything. A failure only logs, and saves what `failed` makes of
   * it, if anything, so the page can say what is missing: the research
   * stands as it was. Returns the dossier the next step should start from:
   * the marked one when that was saved, so the next save keeps the record.
   */
  async #after<T>(
    id: string,
    what: string,
    dossier: T,
    step: (() => Promise<AfterStep<T>>) | undefined,
    save: (dossier: T) => Promise<void>,
    failed: (dossier: T, error: string) => T = (d) => d,
  ): Promise<T> {
    if (!step) return dossier;
    try {
      const r = await step();
      for (const line of r.log) this.#log(`[${id}] ${line}`);
      if (!r.changed) return dossier;
      await save(r.dossier);
      return r.dossier;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log(`[${id}] ${what} failed: ${msg}`);
      const marked = failed(dossier, msg);
      if (marked === dossier) return dossier;
      try {
        await save(marked);
        return marked;
      } catch (e) {
        this.#log(`[${id}] could not record that: ${e}`);
        return dossier;
      }
    }
  }

  /**
   * Merging duplicate claims, then context notes on names, then campaign
   * finance: each a step of its own, each starting from what the last saved.
   * Returns the dossier as the last step left it.
   */
  async #afterDone<T extends RaceDossier | MeasureDossier>(
    id: string,
    done: T,
    steps: AfterSteps<T>,
  ): Promise<T> {
    const makeMerger = this.#makeMerger, makeWriter = this.#makeContextWriter;
    const makeFinance = this.#makeFinanceResearcher;
    const { save } = steps;
    const merged = await this.#after(
      id,
      "merging duplicate claims",
      done,
      makeMerger && (async () => {
        const r = await steps.merge(done, makeMerger());
        return {
          dossier: r.dossier,
          changed: r.groups > 0,
          log: [
            ...(r.sent ? [`merged ${r.groups} duplicate claim(s) among ${r.sent} facts`] : []),
            ...(r.skipped ? [`left ${r.skipped} facts unmerged (over the cap)`] : []),
          ],
        };
      }),
      save,
    );
    // Read when the step starts, so a run finishing just before this one counts.
    let known: KnownNotes = [];
    const noted = await this.#after(
      id,
      "context notes",
      merged,
      makeWriter && (async () => {
        known = this.#store.knownNotes(...steps.place(merged), id);
        const r = await steps.context(merged, makeWriter(), known);
        return {
          dossier: r.dossier,
          // Unchanged only when the facts name no one; otherwise the page lists what was found.
          changed: r.dossier !== merged,
          log: [
            ...(r.sent ? [`wrote ${r.shown - r.reused} context note(s) for ${r.sent} names`] : []),
            ...(r.reused ? [`reused ${r.reused} note(s) from earlier runs in this place`] : []),
            ...(r.skipped ? [`left ${r.skipped} names without a note (over the cap)`] : []),
          ],
        };
      }),
      save,
      (d, error) => steps.contextFailed(d, error, known),
    );
    return await this.#after(
      id,
      "campaign finance",
      noted,
      makeFinance && (async () => {
        const r = await steps.finance(noted, makeFinance());
        return {
          dossier: r.dossier,
          // Every subject gets a result, even an empty one with a gap note.
          changed: r.dossier !== noted,
          log: [
            ...(r.sent ? [`kept ${r.shown} contribution(s) for ${r.sent} subject(s)`] : []),
            ...(r.left_out ? [`listed ${r.left_out} contribution(s) over the cap`] : []),
          ],
        };
      }),
      save,
      steps.financeFailed,
    );
  }

  /**
   * The race's office: an earlier run's lookup of the same office in the same
   * place when one is recent enough, else one capped lookup; then the voter's
   * issues are marked against it. Always changes the race, so always saved.
   */
  async #afterOffice(
    id: string,
    race: RaceDossier,
    save: (d: RaceDossier) => Promise<void>,
  ): Promise<void> {
    const make = this.#makeOfficeResearcher;
    await this.#after(
      id,
      "office powers",
      race,
      make && (async () => {
        const known = this.#store.knownOffice(race.query, id, this.#now());
        const r = await officeForRace(race, make(), known);
        return {
          dossier: r.dossier,
          changed: true,
          log: [
            r.looked_up
              ? `looked up the office: ${r.shown} verified fact(s)`
              : `reused the office lookup from ${known!.from.run}`,
            ...(r.marked ? [`marked ${r.marked} issue(s) against the office's powers`] : []),
          ],
        };
      }),
      save,
      raceOfficeFailed,
    );
  }

  /**
   * The steps after a run is done run beside the queue, not in it: the run
   * is already saved and readable, and the next race shouldn't wait on them.
   * At most one chain per finished run, so spend stays bounded.
   */
  #background(p: Promise<unknown>): void {
    const tracked: Promise<void> = p.then(
      () => {},
      (err) => this.#log(`after-run steps failed: ${err}`),
    )
      .finally(() => this.#post.delete(tracked));
    this.#post.add(tracked);
  }

  /** Races (and measures) waiting or running. */
  get pending(): number {
    return this.#waiting;
  }

  /** How many more races submit() will accept right now. */
  get available(): number {
    return Math.max(0, this.#maxQueued + 1 - this.#waiting);
  }

  #newId(q: RaceQuery): string {
    const stamp = this.#now().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const rand = crypto.getRandomValues(new Uint8Array(3));
    const suffix = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${slug(`${q.city}-${q.office}-${q.electionDate}`).slice(0, 90)}-${stamp}-${suffix}`;
  }

  async submit(
    query: RaceQuery,
    candidates: BallotCandidate[] | null,
    candidateSource: CandidateSource | null = null,
    extras: SubmitExtras = {},
  ): Promise<RunRecord> {
    // One running plus maxQueued waiting.
    if (this.#waiting > this.#maxQueued) {
      throw new QueueFullError(
        `${this.#waiting} races are already waiting. Try again when one finishes.`,
      );
    }
    const at = this.#now().toISOString();
    const id = this.#newId(query);
    const run: RunRecord = {
      id,
      query,
      candidates,
      candidate_source: candidateSource,
      ...(extras.measure ? { measure: extras.measure, measure_result: null } : {}),
      ...(extras.priorities?.length ? { priorities: extras.priorities } : {}),
      choice_id: extras.choiceId ?? id,
      ...(extras.ballot ? { ballot: extras.ballot } : {}),
      status: "queued",
      created_at: at,
      updated_at: at,
      error: null,
      race: null,
    };
    await this.#store.save(run);
    this.#enqueue(run);
    return run;
  }

  /**
   * On startup: every run saved as queued (never started) goes back in line,
   * in submission order. One that can't run is marked interrupted with why:
   * research is off (no API key), or it has waited longer than
   * MAX_RESUME_AGE_MS. Nothing was spent on these, so starting again is free.
   */
  async resumeWaiting(canResearch: boolean): Promise<{ resumed: number; interrupted: number }> {
    const now = this.#now();
    let resumed = 0, interrupted = 0;
    for (const run of this.#store.waiting()) {
      const stale = now.getTime() - Date.parse(run.created_at) > MAX_RESUME_AGE_MS;
      if (canResearch && !stale) {
        this.resume(run);
        resumed++;
        continue;
      }
      await this.#store.save({
        ...run,
        status: "interrupted",
        updated_at: now.toISOString(),
        error: canResearch
          ? "This waited more than a day for the server to come back, so it wasn't started. Start it again if you still want it."
          : "The server restarted without research enabled before this research started.",
      });
      interrupted++;
    }
    return { resumed, interrupted };
  }

  /**
   * Puts a run saved as queued before a restart back in line, behind
   * anything already waiting. Not capped: it was accepted when submitted.
   */
  resume(run: RunRecord): void {
    if (run.status !== "queued") return;
    this.#enqueue(run);
  }

  #enqueue(run: RunRecord): void {
    this.#waiting++;
    this.#tail = this.#tail.then(() => this.#execute(run)).finally(() => {
      this.#waiting--;
    });
  }

  /** Resolves once every submitted race, and the steps after it, have finished. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.#tail;
    while (this.#post.size) await Promise.all(this.#post);
  }

  async #execute(initial: RunRecord): Promise<void> {
    let run: RunRecord = { ...initial, status: "running", updated_at: this.#now().toISOString() };
    const save = async (patch: Partial<RunRecord>) => {
      run = { ...run, ...patch, updated_at: this.#now().toISOString() };
      await this.#store.save(run);
    };
    try {
      await save({});
      if (run.measure) {
        const result = await runMeasure(run.measure, this.#makePort(), {
          priorities: run.priorities,
          onProgress: (m) => this.#log(`[${run.id}] ${m}`),
          onUpdate: (partial) => save({ measure_result: partial }),
        });
        await save({
          measure_result: result,
          status: result.status === "failed" ? "failed" : "done",
          error: result.error,
        });
        if (result.status === "ok") {
          this.#background(this.#afterDone(run.id, result, {
            ...MEASURE_STEPS,
            save: (d) => save({ measure_result: d }),
          }));
        }
        return;
      }
      const race = await runRace(run.query, this.#makePort(), {
        candidates: run.candidates ?? undefined,
        candidateSource: run.candidate_source ?? undefined,
        priorities: run.priorities,
        concurrency: this.#concurrency,
        onProgress: (m) => this.#log(`[${run.id}] ${m}`),
        onUpdate: (partial) => save({ race: partial }),
      });
      await save({ race, status: "done" });
      const saveRace = (d: RaceDossier) => save({ race: d });
      this.#background(
        this.#afterDone(run.id, race, { ...RACE_STEPS, save: saveRace })
          .then((d) => this.#afterOffice(run.id, d, saveRace)),
      );
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

/**
 * Reads uploaded ballots in the background. One call each, usually under a
 * minute, so these don't wait behind races; a small cap bounds spend instead.
 * The uploaded pages exist only in memory for the length of the call.
 */
export class BallotJobs {
  readonly #store: BallotStore;
  readonly #makeReader: () => BallotReader;
  readonly #maxActive: number;
  readonly #now: () => Date;
  readonly #log: (msg: string) => void;
  #active = new Set<Promise<void>>();

  constructor(
    store: BallotStore,
    makeReader: () => BallotReader,
    opts: Omit<JobRunnerOptions, "concurrency" | "maxQueued"> & { maxActive?: number } = {},
  ) {
    this.#store = store;
    this.#makeReader = makeReader;
    this.#maxActive = opts.maxActive ?? 2;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? (() => {});
  }

  get store(): BallotStore {
    return this.#store;
  }

  /** True when submit() would refuse; lets the server refuse before buffering an upload. */
  get full(): boolean {
    return this.#active.size >= this.#maxActive;
  }

  async submit(pages: BallotPage[]): Promise<BallotRecord> {
    if (this.full) {
      throw new QueueFullError(
        "Other ballots are being read right now. Try again in a minute.",
      );
    }
    const at = this.#now().toISOString();
    const stamp = at.replace(/[-:T]/g, "").slice(0, 12);
    const rand = [...crypto.getRandomValues(new Uint8Array(3))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const record: BallotRecord = {
      id: `ballot-${stamp}-${rand}`,
      status: "reading",
      created_at: at,
      updated_at: at,
      error: null,
      pages: pages.length,
      reading: null,
      started: {},
    };
    // Take the slot before the first await, so simultaneous uploads can't all pass the cap.
    let release!: () => void;
    const slot = new Promise<void>((r) => (release = r));
    this.#active.add(slot);
    const free = () => {
      this.#active.delete(slot);
      release();
    };
    try {
      await this.#store.save(record);
    } catch (err) {
      free();
      throw err;
    }
    this.#execute(record, pages).finally(free);
    return record;
  }

  /** Resolves once every submitted ballot has been read. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#active.size) await Promise.all(this.#active);
  }

  async #execute(record: BallotRecord, pages: BallotPage[]): Promise<void> {
    const save = (patch: Partial<BallotRecord>) =>
      this.#store.save({ ...record, ...patch, updated_at: this.#now().toISOString() });
    try {
      const reading = await this.#makeReader().readBallot(pages);
      this.#log(`[${record.id}] read ${reading.contests.length} contests`);
      await save({ status: "read", reading });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log(`[${record.id}] failed: ${msg}`);
      try {
        await save({ status: "failed", error: msg });
      } catch (saveErr) {
        this.#log(`[${record.id}] could not record failure: ${saveErr}`);
      }
    }
  }
}
