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
 * why. There is no model fallback here. Each run is read again just before
 * its save, and only its finance changes; the graph is rebuilt for it in the
 * same save.
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

/** Whether a run is a finished race or measure in `place`. */
export function inPlace(run: RunRecord, place: string): boolean {
  const p = placeOf(run);
  return run.status === "done" && !!p && jurisdictionKey(p) === jurisdictionKey(place);
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
  const args = parseArgs(Deno.args, { string: ["data", "from", "place", "only"] });
  const [cmd] = args._.map(String);
  if (!args.place) throw new Error("--place <name> is needed, e.g. --place Fontana");
  const place = args.place;
  const stores = await openStores(args.data ?? "data");
  try {
    if (cmd === "run") {
      const netfile = new NetFileResearcher({
        source: new NetFileClient(),
        agencies: parseAgencyMap(Deno.env.get("BALLOTFIX_NETFILE_AGENCIES")),
        log: (m) => console.log(m),
      });
      let saved = 0;
      for (const run of await stores.runs.list()) {
        if (!inPlace(run, place) || (args.only && run.id !== args.only)) continue;
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
          if (await saveFinance(stores.runs, run.id, subjectsOf(run), f)) saved++;
        } catch (err) {
          console.log(
            `${run.id}: kept as it was. ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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
        theirs.set(row.id, JSON.parse(row.body) as RunRecord);
      }
      src.close();
      let copied = 0, skipped = 0;
      for (const run of await stores.runs.list()) {
        if (!inPlace(run, place)) continue;
        const t = theirs.get(run.id);
        const f = t && financeOf(t);
        if (!t || !f || f.source?.kind !== "netfile") continue;
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
    } else {
      console.log("usage: finance run|apply --data <dir> --place <name> [--only id] [--from db]");
    }
  } finally {
    stores.db.close();
  }
}
