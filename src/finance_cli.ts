/**
 * Campaign finance from NetFile for saved runs (roadmap item 18): `deno task finance`.
 *
 *   run --data <dir> --place <name> [--only <id>]   reads each finished race's and
 *                                     measure's filings in that place from NetFile's
 *                                     public search (netfile.com only, no model) and
 *                                     saves them in place of its finance step
 *   apply --from <db> --data <dir> --place <name>    copies NetFile finance made on a
 *                                     copy onto the same runs here, where the subjects
 *                                     are the same; calls nothing
 *
 * Only a result read from NetFile is saved: where the place isn't on NetFile
 * or no committee matches, the run keeps what it had and the command says
 * why. There is no model fallback here. A result with fewer contributions for
 * any subject than the run already has is not saved (a year unreadable, the
 * export cut short, a committee not matched) unless given --replace, and
 * apply skips a run whose finance here is already from NetFile, so an older
 * copy never replaces a newer read. Each run is read again just before its
 * save, and only its finance changes; the graph is rebuilt for it in the
 * same save.
 *
 * On live data, use it only while no run is in its after-done steps: the job
 * runner holds that run in memory and would save its own finance back over this.
 */

import { parseArgs } from "@std/cli/parse-args";
import { DatabaseSync } from "node:sqlite";
import { financeForMeasure, financeForRace } from "./finance.ts";
import { jurisdictionKey } from "./knowledge.ts";
import { NetFileClient, NetFileResearcher, parseAgencyMap } from "./netfile.ts";
import type { FinanceResult } from "./types.ts";
import { openStores, type RunRecord, type RunStore } from "./web/store.ts";

function placeOf(run: RunRecord): string | null {
  return run.measure_result?.query.jurisdiction ?? run.race?.query.city ?? null;
}

/** Who the finance step looks up: the same names in the same order, or the result doesn't fit. */
export function subjectsOf(run: RunRecord): string {
  if (run.measure_result) return JSON.stringify(["support", "oppose", run.measure_result.query]);
  return JSON.stringify(
    (run.race?.candidates ?? []).flatMap((c) => c.status === "pending" ? [] : [c.candidate.name]),
  );
}

function financeOf(run: RunRecord): FinanceResult | undefined {
  return (run.measure_result ?? run.race)?.finance;
}

/** Whether a run is a finished race or measure in `place`, in `state` (NetFile is California's). */
export function inPlace(run: RunRecord, place: string, state = "CA"): boolean {
  const p = placeOf(run);
  const st = (run.measure_result ?? run.race)?.query.state ?? "";
  return run.status === "done" && !!p && st.toUpperCase() === state.toUpperCase() &&
    jurisdictionKey(p) === jurisdictionKey(place);
}

/** The subjects (by their place in the result) that would have fewer contributions after than before. */
export function losesRows(before: FinanceResult | undefined, after: FinanceResult): number[] {
  if (!before) return [];
  return after.subjects.flatMap((s, i) =>
    s.contributions.length < (before.subjects[i]?.contributions.length ?? 0) ? [i] : []
  );
}

/** Only finance goes onto the run as it is now, and only if it looks up the same subjects. */
async function saveFinance(
  store: RunStore,
  id: string,
  subjects: string,
  finance: FinanceResult,
): Promise<boolean> {
  const fresh = await store.get(id);
  if (!fresh || fresh.status !== "done" || subjectsOf(fresh) !== subjects) {
    console.log(`${id}: changed since it was read; not saved`);
    return false;
  }
  await store.save(
    fresh.measure_result
      ? { ...fresh, measure_result: { ...fresh.measure_result, finance } }
      : { ...fresh, race: { ...fresh.race!, finance } },
  );
  return true;
}

function describe(f: FinanceResult): string {
  const rows = f.subjects.map((s) => s.contributions.length);
  return `${rows.reduce((a, b) => a + b, 0)} contribution(s) (${
    rows.join(", ")
  } by subject), ${f.portal_gaps.length} portal gap(s)`;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["data", "from", "place", "only", "state"],
    boolean: ["replace"],
  });
  const [cmd] = args._.map(String);
  if (cmd !== "run" && cmd !== "apply") {
    console.log(
      "usage: finance run|apply --data <dir> --place <name> [--state CA] [--only id] [--from db] [--replace]",
    );
    Deno.exit(cmd ? 1 : 0);
  }
  if (!args.place) throw new Error("--place <name> is needed, e.g. --place Fontana");
  const place = args.place;
  const state = args.state ?? "CA";
  /** Why a result isn't saved over what the run has, or "" to save it. */
  const refuse = (before: FinanceResult | undefined, f: FinanceResult) => {
    const lost = losesRows(before, f);
    return lost.length && !args.replace
      ? `fewer contributions than it has for subject(s) ${
        lost.map((i) => i + 1).join(", ")
      }; kept as it was (--replace saves it anyway)`
      : "";
  };
  const stores = await openStores(args.data ?? "data");
  try {
    if (cmd === "run") {
      const netfile = new NetFileResearcher({
        source: new NetFileClient(),
        agencies: parseAgencyMap(Deno.env.get("BALLOTFIX_NETFILE_AGENCIES")),
        log: (m) => console.log(m),
      });
      let saved = 0, matched = 0;
      for (const run of await stores.runs.list()) {
        if (!inPlace(run, place, state) || (args.only && run.id !== args.only)) continue;
        matched++;
        const before = financeOf(run);
        try {
          const f = run.measure_result
            ? (await financeForMeasure(run.measure_result, netfile)).dossier.finance
            : (await financeForRace(run.race!, netfile)).dossier.finance;
          if (!f || f.source?.kind !== "netfile") {
            console.log(`${run.id}: nothing read from NetFile; kept as it was`);
            continue;
          }
          console.log(
            `${run.id}: was ${before ? describe(before) : "not looked up"}; now ${describe(f)}`,
          );
          const no = refuse(before, f);
          if (no) {
            console.log(`${run.id}: ${no}`);
            continue;
          }
          if (await saveFinance(stores.runs, run.id, subjectsOf(run), f)) saved++;
        } catch (err) {
          console.log(
            `${run.id}: kept as it was. ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (!matched) {
        console.log(
          `no finished race or measure in ${place}${args.only ? ` with id ${args.only}` : ""}.`,
        );
      }
      console.log(`saved NetFile finance for ${saved} run(s) in ${place}.`);
    } else if (cmd === "apply") {
      if (!args.from) throw new Error("apply needs --from <ballotfix.db>");
      const src = new DatabaseSync(args.from, { readOnly: true });
      const theirs = new Map<string, RunRecord>();
      for (
        const row of src.prepare("SELECT id, body FROM runs").all() as {
          id: string;
          body: string;
        }[]
      ) {
        try {
          theirs.set(row.id, JSON.parse(row.body) as RunRecord);
        } catch {
          console.log(`${row.id}: unreadable in the copy; skipped`);
        }
      }
      src.close();
      let copied = 0, skipped = 0;
      for (const run of await stores.runs.list()) {
        if (!inPlace(run, place, state)) continue;
        const t = theirs.get(run.id);
        const f = t && financeOf(t);
        if (!t || !f || f.source?.kind !== "netfile") continue;
        const here = financeOf(run);
        if (here?.source?.kind === "netfile" && !args.replace) {
          skipped++;
          console.log(`${run.id}: its finance here is already from NetFile; skipped`);
          continue;
        }
        const no = refuse(here, f);
        if (no) {
          skipped++;
          console.log(`${run.id}: ${no}`);
          continue;
        }
        // The copy's body is as saved; its places may read differently, the subjects can't.
        if (subjectsOf(t) !== subjectsOf(run)) {
          skipped++;
          console.log(`${run.id}: its subjects differ from the copy's; skipped`);
          continue;
        }
        if (await saveFinance(stores.runs, run.id, subjectsOf(run), f)) {
          copied++;
          console.log(`${run.id}: ${describe(f)}`);
        }
      }
      console.log(`copied NetFile finance for ${copied} run(s), ${skipped} skipped.`);
    }
  } finally {
    stores.db.close();
  }
}
