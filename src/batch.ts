/**
 * One Message Batch (half the list price) for the backfill commands: each
 * request keyed, results read back by key, never by position. Every result
 * logs one usage line, and the batch its total, at the batch discount.
 */

import Anthropic from "@anthropic-ai/sdk";
import { estimateCost, usageLine } from "./research/anthropic.ts";

/** How long a command waits on a batch before giving up (most end within the hour). */
export const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 30_000;

export type BatchResult = { raw?: unknown; error?: string };

export async function batch(
  client: Anthropic,
  requests: { key: string; params: unknown }[],
  model: string,
  label: string,
): Promise<Map<string, BatchResult>> {
  const out = new Map<string, BatchResult>();
  if (!requests.length) return out;
  const created = await client.messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.key,
      // output_config and adaptive thinking are Messages API fields the batch takes as is.
      params: r.params as Anthropic.MessageCreateParamsNonStreaming,
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
    console.log(usageLine(`${label} ${r.custom_id} (batch: half this)`, model, u));
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
  console.log(`batch ${b.id}: about $${spent.toFixed(4)} at the batch discount`);
  return out;
}
