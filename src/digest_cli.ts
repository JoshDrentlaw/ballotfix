/**
 * Digests for saved runs (roadmap item 15): `deno task digest`.
 *
 *   estimate --data <dir>             what a run would send and cost; calls nothing
 *   run --data <dir> --yes [--only id,id]
 *                                     one Message Batch for every finished run
 *                                     without a current digest, then one more for
 *                                     those whose answer failed a check
 *   apply --from <db> --data <dir>    copies digests made on a copy onto the same
 *                                     runs here, only where the facts hash the
 *                                     same; calls nothing
 *
 * It spends money, so `run` prints its estimate and stops unless given --yes.
 * Each run is saved through RunStore as the job runner saves it, and a digest
 * whose input hash matches is never made again.
 */

import Anthropic from "@anthropic-ai/sdk";
import { parseArgs } from "@std/cli/parse-args";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_DIGEST_MODEL,
  DIGEST_SYSTEM,
  digestAnswer,
  digestBatchParams,
  digestPrompt,
  estimateCost,
  usageLine,
} from "./research/anthropic.ts";
import {
  digestFailed,
  type DigestPlan,
  isCurrent,
  leftOut,
  planMeasure,
  planRace,
  problemsOf,
} from "./digest.ts";
import type { DigestRequest, DigestResult, SubjectDigest } from "./types.ts";
import { openStores, type RunRecord, type RunStore } from "./web/store.ts";

/** How long `run` waits on a batch before giving up (most end within the hour). */
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 30_000;
/** Output per summarized section and per brief, thinking included: an assumption. */
const OUTPUT_PER_SECTION = 400;
const OUTPUT_PER_BRIEF = 500;

interface Planned {
  run: RunRecord;
  plan: DigestPlan<unknown>;
}

function planOf(run: RunRecord, model: string, now: Date): DigestPlan<unknown> | null {
  if (run.status !== "done") return null;
  if (run.measure_result) return planMeasure(run.measure_result, model, now);
  if (run.race) return planRace(run.race, model, now);
  return null;
}

function withDigest(run: RunRecord, dossier: unknown): RunRecord {
  return run.measure_result
    ? { ...run, measure_result: dossier as RunRecord["measure_result"] }
    : { ...run, race: dossier as RunRecord["race"] };
}

function dossierOf(run: RunRecord): { digest?: DigestResult } {
  return run.measure_result ?? run.race ?? {};
}

/** Rough list-price estimate of one request, before the batch discount. */
function estimate(request: DigestRequest, model: string): number {
  const input = Math.ceil((DIGEST_SYSTEM.length + digestPrompt(request).length) / 4);
  const sections = request.subjects.reduce(
    (a, s) => a + s.sections.filter((x) => x.summarize).length,
    0,
  );
  const briefs = request.subjects.filter((s) => s.brief).length;
  const output = sections * OUTPUT_PER_SECTION + briefs * OUTPUT_PER_BRIEF;
  return estimateCost(model, {
    requests: 1,
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    searches: 0,
    fetches: 0,
  }) ?? 0;
}

async function plans(store: RunStore, model: string, only: Set<string> | null) {
  const now = new Date();
  const todo: Planned[] = [];
  let current = 0, none = 0;
  for (const run of await store.list()) {
    if (only && !only.has(run.id)) continue;
    const plan = planOf(run, model, now);
    if (!plan) {
      if (run.status === "done") none++;
      continue;
    }
    if (isCurrent(dossierOf(run), plan)) current++;
    else todo.push({ run, plan });
  }
  return { todo, current, none };
}

function report(todo: Planned[], current: number, none: number, model: string): number {
  let total = 0;
  for (const { run, plan } of todo) {
    const cost = plan.sent ? estimate(plan.request, model) : 0;
    total += cost;
    console.log(
      `${run.id}: ${
        plan.sent ? `${plan.sent} facts, about $${cost.toFixed(3)}` : "over the cap, no call"
      }`,
    );
  }
  console.log(
    `\n${todo.length} run(s) to digest, ${current} already current, ${none} with too few facts.`,
  );
  console.log(
    `Estimate (an assumption) at list price: $${total.toFixed(2)}; as a batch, half: $${
      (total / 2).toFixed(2)
    }. A retry for answers that fail a check can add up to as much again.`,
  );
  return total;
}

/** One Message Batch: each request keyed by its index, results read back by key. */
async function batch(
  client: Anthropic,
  requests: { key: string; request: DigestRequest }[],
  model: string,
): Promise<Map<string, { raw?: unknown; error?: string }>> {
  const out = new Map<string, { raw?: unknown; error?: string }>();
  if (!requests.length) return out;
  const created = await client.messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.key,
      // output_config and adaptive thinking are Messages API fields the batch takes as is.
      params: digestBatchParams(
        r.request,
        model,
      ) as unknown as Anthropic.MessageCreateParamsNonStreaming,
    })),
  });
  console.log(`batch ${created.id}: ${requests.length} request(s)`);
  const start = Date.now();
  let b = created;
  while (b.processing_status !== "ended") {
    if (Date.now() - start > MAX_WAIT_MS) {
      throw new Error(`batch ${b.id} still running after ${MAX_WAIT_MS / 60000} minutes`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    b = await client.messages.batches.retrieve(b.id);
    console.log(`  ${b.processing_status}: ${JSON.stringify(b.request_counts)}`);
  }
  let spent = 0;
  for await (const r of await client.messages.batches.results(b.id)) {
    if (r.result.type !== "succeeded") {
      out.set(r.custom_id, { error: `batch request ${r.result.type}` });
      continue;
    }
    const m = r.result.message;
    const u = {
      requests: 1,
      input: m.usage.input_tokens,
      output: m.usage.output_tokens,
      cacheRead: m.usage.cache_read_input_tokens ?? 0,
      cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
      searches: 0,
      fetches: 0,
    };
    spent += (estimateCost(model, u) ?? 0) / 2;
    console.log(usageLine(`digest ${r.custom_id} (batch: half this)`, model, u));
    if (m.stop_reason === "refusal") {
      out.set(r.custom_id, { error: "the model declined" });
      continue;
    }
    if (m.stop_reason === "max_tokens") {
      out.set(r.custom_id, { error: "the answer hit max_tokens before finishing" });
      continue;
    }
    const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    try {
      out.set(r.custom_id, { raw: JSON.parse(text) });
    } catch {
      out.set(r.custom_id, { error: "the answer was not valid JSON" });
    }
  }
  console.log(`batch ${b.id}: about $${spent.toFixed(3)} at the batch discount`);
  return out;
}

async function run(store: RunStore, model: string, todo: Planned[]): Promise<void> {
  const client = new Anthropic();
  const sendable = todo.filter((t) => t.plan.sent);
  const first = await batch(
    client,
    sendable.map((t, i) => ({ key: `r${i}`, request: t.plan.request })),
    model,
  );
  const checked = new Map<number, SubjectDigest[]>();
  const errors = new Map<number, string>();
  const retry: { i: number; request: DigestRequest }[] = [];
  sendable.forEach((t, i) => {
    const got = first.get(`r${i}`);
    if (!got || got.error) return errors.set(i, got?.error ?? "no result came back");
    const c = t.plan.check(digestAnswer(got.raw));
    checked.set(i, c);
    const problems = problemsOf(t.plan.request, c);
    if (problems.length) retry.push({ i, request: { ...t.plan.request, problems } });
  });
  if (retry.length) {
    console.log(`${retry.length} answer(s) failed a check; sending them back once.`);
    // A failed retry batch keeps the first answers: they were already paid for.
    const second = await batch(
      client,
      retry.map((r) => ({ key: `r${r.i}`, request: r.request })),
      model,
    ).catch((e) => {
      console.log(`retry batch failed, keeping the first answers: ${e}`);
      return new Map<string, { raw?: unknown; error?: string }>();
    });
    for (const { i } of retry) {
      const got = second.get(`r${i}`);
      if (!got?.raw) continue;
      const c = sendable[i].plan.check(digestAnswer(got.raw));
      if (leftOut(c) < leftOut(checked.get(i)!)) checked.set(i, c);
    }
  }
  for (const [i, t] of sendable.entries()) {
    const c = checked.get(i);
    const dossier = c ? t.plan.finish(c) : digestFailed(t.plan, errors.get(i) ?? "no result");
    if (!(await saveDigest(store, t, model, dossier))) continue;
    console.log(
      `${t.run.id}: ${c ? `saved, ${leftOut(c)} left out` : `recorded failure: ${errors.get(i)}`}`,
    );
  }
  for (const t of todo.filter((t) => !t.plan.sent)) {
    await saveDigest(store, t, model, t.plan.finish(null));
  }
}

/**
 * Puts only the digest onto the run as it is now, read again just before
 * saving, so a change made meanwhile (the server's own steps) isn't
 * overwritten. Skipped when the facts changed since the plan: the digest's
 * citations point at facts by place.
 */
async function saveDigest(
  store: RunStore,
  t: Planned,
  model: string,
  made: unknown,
): Promise<boolean> {
  const fresh = await store.get(t.run.id);
  const now = fresh && planOf(fresh, model, new Date());
  if (!fresh || !now || now.hash !== t.plan.hash) {
    console.log(`${t.run.id}: changed since it was planned; not saved`);
    return false;
  }
  const digest = (made as { digest?: DigestResult }).digest;
  await store.save(withDigest(fresh, { ...(fresh.measure_result ?? fresh.race), digest }));
  return true;
}

/** Copies digests from another database's runs, only where this run's facts hash the same. */
async function apply(store: RunStore, from: string, model: string): Promise<void> {
  const src = new DatabaseSync(from, { readOnly: true });
  const theirs = new Map<string, unknown>();
  for (
    const row of src.prepare("SELECT id, body FROM runs").all() as { id: string; body: string }[]
  ) {
    const b = JSON.parse(row.body) as RunRecord;
    const d = dossierOf(b).digest;
    if (d) theirs.set(row.id, d);
  }
  src.close();
  const now = new Date();
  let copied = 0, skipped = 0;
  for (const run of await store.list()) {
    const digest = theirs.get(run.id) as DigestResult | undefined;
    const plan = planOf(run, model, now);
    if (!digest || !plan) continue;
    if (digest.input_hash !== plan.hash) {
      console.log(`${run.id}: facts differ from the copy's; not copied`);
      skipped++;
      continue;
    }
    if (isCurrent(dossierOf(run), plan)) continue;
    const dossier = run.measure_result ?? run.race;
    await store.save(withDigest(run, { ...dossier, digest }));
    copied++;
  }
  console.log(`copied ${copied} digest(s), ${skipped} skipped because the facts differ.`);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["data", "from", "only", "model"],
    boolean: ["yes"],
  });
  const [cmd] = args._.map(String);
  const data = args.data ?? "data";
  const model = args.model ?? Deno.env.get("BALLOTFIX_DIGEST_MODEL") ?? DEFAULT_DIGEST_MODEL;
  const only = args.only ? new Set(args.only.split(",")) : null;
  // "off" (or a model without a price) would send a batch that can't run, or estimate it at $0.
  if (cmd === "run" || cmd === "estimate") {
    const zero = {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      searches: 0,
      fetches: 0,
    };
    if (estimateCost(model, zero) === null) {
      throw new Error(`no price for model "${model}"; pass --model or set BALLOTFIX_DIGEST_MODEL`);
    }
  }
  const stores = await openStores(data);
  try {
    if (cmd === "apply") {
      if (!args.from) throw new Error("apply needs --from <ballotfix.db>");
      await apply(stores.runs, args.from, model);
    } else if (cmd === "estimate" || cmd === "run") {
      const { todo, current, none } = await plans(stores.runs, model, only);
      report(todo, current, none, model);
      if (cmd === "run") {
        if (!args.yes) console.log("\nNothing sent. Add --yes to spend this.");
        else await run(stores.runs, model, todo);
      }
    } else {
      console.log(
        "usage: digest estimate|run|apply --data <dir> [--yes] [--only id,id] [--from db]",
      );
    }
  } finally {
    stores.db.close();
  }
}
