/**
 * Adapter tests against a stubbed SDK client: no network. Covers pause_turn
 * resumption, refusal handling, retrieved-URL collection, and the request
 * shape (server tools, schema, fallbacks).
 */
import { assertEquals, assertRejects } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import Anthropic_ from "@anthropic-ai/sdk";
import {
  AnthropicResearcher,
  describeApiError,
  ResearchIncompleteError,
  ResearchRefusedError,
  ResearchUnavailableError,
} from "../src/research/anthropic.ts";
import { SECTION_IDS } from "../src/template.ts";
import { listing, QUERY } from "./fakes.ts";

type Resp = { stop_reason: string; content: unknown[]; stop_details?: unknown };

function stubClient(responses: Resp[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(req: Record<string, unknown>) {
          // Snapshot: the adapter mutates its messages array between turns.
          requests.push(structuredClone(req));
          const r = responses.shift();
          if (!r) throw new Error("no more stubbed responses");
          return { finalMessage: () => Promise.resolve(r) };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const search = {
  type: "web_search_tool_result",
  tool_use_id: "s1",
  content: [{
    type: "web_search_result",
    url: "https://kvcrnews.org/a",
    title: "A",
    page_age: null,
    encrypted_content: "",
  }],
};
const fetched = {
  type: "web_fetch_tool_result",
  tool_use_id: "f1",
  content: {
    type: "web_fetch_result",
    url: "https://oag.ca.gov/b",
    retrieved_at: null,
    content: {},
  },
};
const fetchError = {
  type: "web_fetch_tool_result",
  tool_use_id: "f2",
  content: { type: "web_fetch_tool_error", error_code: "url_not_accessible" },
};

const cand = { name: "Acquanetta Warren", ballot_designation: "Mayor", incumbent: true };
const emptySections = Object.fromEntries(
  SECTION_IDS.map((id) => [id, { facts: [], searched: [], gap_note: "none" }]),
);

Deno.test("resumes after pause_turn and collects URLs across all turns", async () => {
  const final = JSON.stringify({ sections: emptySections, identity_note: null, gaps: ["x"] });
  const { client, requests } = stubClient([
    {
      stop_reason: "pause_turn",
      content: [{ type: "text", text: "Searching...", citations: null }, search],
    },
    {
      stop_reason: "end_turn",
      content: [fetched, fetchError, { type: "text", text: "narration", citations: null }, {
        type: "text",
        text: final,
        citations: null,
      }],
    },
  ]);
  const r = await new AnthropicResearcher({ client }).researchCandidate(
    QUERY,
    cand,
    listing([cand]),
  );
  assertEquals(requests.length, 2);
  assertEquals((requests[1].messages as unknown[]).length, 2); // user + paused assistant turn
  assertEquals(r.retrieved_urls.sort(), ["https://kvcrnews.org/a", "https://oag.ca.gov/b"]);
  assertEquals(r.gaps, ["x"]);
});

Deno.test("request uses server web tools, a schema requiring every section, and default fallbacks", async () => {
  const final = JSON.stringify({ sections: emptySections, identity_note: null, gaps: [] });
  const { client, requests } = stubClient([{
    stop_reason: "end_turn",
    content: [{ type: "text", text: final }],
  }]);
  await new AnthropicResearcher({ client }).researchCandidate(QUERY, cand, listing([cand]));
  const req = requests[0] as {
    tools: { type: string }[];
    fallbacks: string;
    betas: string[];
    output_config: { format: { schema: { properties: { sections: { required: string[] } } } } };
  };
  assertEquals(req.tools.map((t) => t.type), ["web_search_20260209", "web_fetch_20260209"]);
  assertEquals(req.fallbacks, "default");
  assertEquals(req.betas, ["server-side-fallback-2026-07-01"]);
  assertEquals(req.output_config.format.schema.properties.sections.required, [...SECTION_IDS]);
});

Deno.test("refusal raises ResearchRefusedError", async () => {
  const { client } = stubClient([{
    stop_reason: "refusal",
    content: [],
    stop_details: { category: "bio" },
  }]);
  await assertRejects(
    () => new AnthropicResearcher({ client }).researchCandidate(QUERY, cand, listing([cand])),
    ResearchRefusedError,
  );
});

Deno.test("non-JSON final text raises ResearchIncompleteError", async () => {
  const { client } = stubClient([{
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Sorry" }],
  }]);
  await assertRejects(
    () => new AnthropicResearcher({ client }).researchCandidate(QUERY, cand, listing([cand])),
    ResearchIncompleteError,
  );
});

Deno.test("findBallot sanitizes order_basis and blank names", async () => {
  const body = JSON.stringify({
    candidates: [{ name: " Joz Sida ", ballot_designation: "", incumbent: false }, {
      name: "",
      ballot_designation: null,
      incumbent: false,
    }],
    source_name: "Registrar",
    source_url: null,
    order_basis: "by_popularity",
    notes: null,
  });
  const { client } = stubClient([{
    stop_reason: "end_turn",
    content: [search, { type: "text", text: body }],
  }]);
  const l = await new AnthropicResearcher({ client }).findBallot(QUERY);
  assertEquals(l.candidates, [{ name: "Joz Sida", ballot_designation: null, incumbent: false }]);
  assertEquals(l.order_basis, "unofficial");
  assertEquals(l.retrieved_urls, ["https://kvcrnews.org/a"]);
});

Deno.test("SDK errors become plain-language messages for the app", async () => {
  const auth = new Anthropic_.AuthenticationError(
    401,
    { type: "error" },
    "invalid x-api-key",
    new Headers(),
  );
  const { client } = stubClient([]);
  (client.beta.messages as unknown as { stream: () => never }).stream = () => {
    throw auth;
  };
  const err = await assertRejects(
    () => new AnthropicResearcher({ client }).findBallot(QUERY),
    ResearchUnavailableError,
  );
  assertEquals(err.message.includes("API key was rejected"), true);
  const plain = new Error("something else");
  assertEquals(describeApiError(plain), plain);
});
