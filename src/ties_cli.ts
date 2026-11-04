/**
 * Tie roles for saved runs (roadmap item 16): `deno task ties`.
 *
 *   estimate --data <dir>             the ties each run would send; calls nothing
 *   run --data <dir> --yes            one Message Batch for every finished run
 *                                     whose ties aren't marked for these facts
 *   apply --from <db> --data <dir>    copies marks made on a copy onto the same
 *                                     runs here, only where the ties hash the
 *                                     same; calls nothing
 *
 * `run` prints its estimate and stops unless given --yes. Each run is saved
 * through RunStore with only its tie_roles changed, read again just before.
 */

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "@std/cli/parse-args";
import { DatabaseSync } from "node:sqlite";
import { batch } from "./batch.ts";
import {
  DEFAULT_TIES_MODEL,
  estimateCost,
  TIES_SYSTEM,
  tiesAnswer,
  tiesBatchParams,
  tiesPrompt,
} from "./research/anthropic.ts";
import { planMeasureTies, planRaceTies, type TiePlan, tiesCurrent } from "./ties.ts";
import type { TieRoleResult } from "./types.ts";
import { openStores, type RunRecord, type RunStore } from "./web/store.ts";

/** Output per tie, thinking included: an assumption. */
const OUTPUT_PER_TIE = 150;

function planOf(run: RunRecord, model: string, now: Date): TiePlan<unknown> | null {
  if (run.status !== "done") return null;
  if (run.measure_result) return planMeasureTies(run.measure_result, model, now);
  if (run.race) return planRaceTies(run.race, model, now);
  return null;
}

function dossierOf(run: RunRecord): { tie_roles?: TieRoleResult } {
  return run.measure_result ?? run.race ?? {};
}

/** Only tie_roles goes onto the run as it is now, and only if its ties are still the planned ones. */
async function saveMarks(
  store: RunStore,
  id: string,
  hash: string,
  model: string,
  tie_roles: TieRoleResult,
): Promise<boolean> {
  const fresh = await store.get(id);
  const now = fresh && planOf(fresh, model, new Date());
  if (!fresh || !now || now.hash !== hash) {
    console.log(`${id}: changed since it was planned; not saved`);
    return false;
  }
  await store.save(
    fresh.measure_result
      ? { ...fresh, measure_result: { ...fresh.measure_result, tie_roles } }
      : { ...fresh, race: { ...fresh.race!, tie_roles } },
  );
  return true;
}

async function plans(store: RunStore, model: string) {
  const now = new Date();
  const todo: { run: RunRecord; plan: TiePlan<unknown> }[] = [];
  let current = 0;
  for (const run of await store.list()) {
    const plan = planOf(run, model, now);
    if (!plan) continue;
    if (tiesCurrent(dossierOf(run), plan)) current++;
    else todo.push({ run, plan });
  }
  return { todo, current };
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ["data", "from", "model"], boolean: ["yes"] });
  const [cmd] = args._.map(String);
  const model = args.model ?? Deno.env.get("BALLOTFIX_TIES_MODEL") ?? DEFAULT_TIES_MODEL;
  const zero = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    searches: 0,
    fetches: 0,
  };
  if (cmd !== "apply" && estimateCost(model, zero) === null) {
    throw new Error(`no price for model "${model}"; pass --model or set BALLOTFIX_TIES_MODEL`);
  }
  const stores = await openStores(args.data ?? "data");
  try {
    if (cmd === "apply") {
      if (!args.from) throw new Error("apply needs --from <ballotfix.db>");
      const src = new DatabaseSync(args.from, { readOnly: true });
      const theirs = new Map<string, TieRoleResult>();
      for (
        const row of src.prepare("SELECT id, body FROM runs").all() as {
          id: string;
          body: string;
        }[]
      ) {
        const t = dossierOf(JSON.parse(row.body) as RunRecord).tie_roles;
        // A failed marking there is nothing to copy: this run would only look attempted.
        if (t && !t.error) theirs.set(row.id, t);
      }
      src.close();
      let copied = 0, skipped = 0;
      for (const run of await stores.runs.list()) {
        const t = theirs.get(run.id);
        const plan = planOf(run, model, new Date());
        if (!t || !plan || tiesCurrent(dossierOf(run), plan)) continue;
        if (t.input_hash !== plan.hash) {
          skipped++;
          continue;
        }
        if (await saveMarks(stores.runs, run.id, plan.hash, model, t)) copied++;
      }
      console.log(`copied marks for ${copied} run(s), ${skipped} skipped because the ties differ.`);
    } else if (cmd === "estimate" || cmd === "run") {
      const { todo, current } = await plans(stores.runs, model);
      let total = 0, ties = 0;
      for (const { run, plan } of todo) {
        const input = Math.ceil((TIES_SYSTEM.length + tiesPrompt(plan.request).length) / 4);
        const output = plan.request.ties.length * OUTPUT_PER_TIE;
        total += estimateCost(model, { ...zero, requests: 1, input, output }) ?? 0;
        ties += plan.request.ties.length;
        console.log(`${run.id}: ${plan.request.ties.length} tie(s)`);
      }
      console.log(
        `\n${todo.length} run(s), ${ties} tie(s) to mark, ${current} already current. Estimate (an assumption): $${
          total.toFixed(4)
        } at list price, half as a batch.`,
      );
      if (cmd === "run" && !args.yes) console.log("Nothing sent. Add --yes to spend this.");
      if (cmd === "run" && args.yes && todo.length) {
        const got = await batch(
          new Anthropic(),
          todo.map((t, i) => ({ key: `r${i}`, params: tiesBatchParams(t.plan.request, model) })),
          model,
          "tie roles",
        );
        for (const [i, t] of todo.entries()) {
          const r = got.get(`r${i}`);
          const marks = r?.raw === undefined ? null : t.plan.check(tiesAnswer(r.raw));
          const done = t.plan.finish(marks, marks ? undefined : r?.error ?? "no result came back");
          const roles = (done as { tie_roles: TieRoleResult }).tie_roles;
          if (await saveMarks(stores.runs, t.run.id, t.plan.hash, model, roles)) {
            console.log(
              `${t.run.id}: ${
                marks ? `${marks.length} of ${t.plan.request.ties.length} marked` : roles.error
              }`,
            );
          }
        }
      }
    } else {
      console.log("usage: ties estimate|run|apply --data <dir> [--yes] [--from db]");
    }
  } finally {
    stores.db.close();
  }
}
