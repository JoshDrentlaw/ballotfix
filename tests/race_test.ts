import { assertEquals, assertMatch } from "@std/assert";
import { mapLimit, runRace } from "../src/race.ts";
import { FakeResearch, listing, QUERY, raw } from "./fakes.ts";

const names = ["Jackie Heredia", "Acquanetta Warren", "Sal Casillas", "Joz Sida"];
const cands = names.map((name) => ({
  name,
  ballot_designation: null,
  incumbent: name === "Acquanetta Warren",
}));

Deno.test("candidates come out in ballot order regardless of completion order", async () => {
  const out = await mapLimit([30, 1, 20, 5], 4, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assertEquals(out, [30, 1, 20, 5]);
});

Deno.test("runRace keeps every candidate, in listing order, and isolates failures", async () => {
  const port = new FakeResearch(listing(cands), {
    "Sal Casillas": new Error("rate limited"),
    "Joz Sida": raw({ gaps: ["Campaign site did not load."] }),
  });
  const race = await runRace(QUERY, port, {
    concurrency: 2,
    now: () => new Date("2026-09-23T00:00:00Z"),
  });
  assertEquals(race.candidates.map((c) => c.candidate.name), names);
  assertEquals(race.candidates.map((c) => c.status), ["ok", "ok", "failed", "ok"]);
  assertMatch(race.candidates[2].gaps[0], /rate limited/);
  assertEquals(race.candidates[3].gaps, ["Campaign site did not load."]);
  assertEquals(race.generated_at, "2026-09-23T00:00:00.000Z");
  assertEquals(race.standing_gaps.length > 0, true);
});

Deno.test("a supplied candidate list skips discovery and is labeled unofficial", async () => {
  const port = new FakeResearch(listing([]), {});
  const race = await runRace(QUERY, port, { candidates: cands.slice(0, 2) });
  assertEquals(port.calls.includes("ballot"), false);
  assertEquals(race.listing.order_basis, "unofficial");
  assertEquals(race.candidates.length, 2);
});
