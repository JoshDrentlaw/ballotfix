import { assert, assertEquals } from "@std/assert";
import { inPlace, subjectsOf } from "../src/finance_cli.ts";
import type { RunRecord } from "../src/web/store.ts";

const run = (city: string, names: string[], status = "done") =>
  ({
    id: "r",
    status,
    race: {
      query: { city, state: "CA", office: "City Clerk", electionDate: "2026-11-03" },
      candidates: names.map((name) => ({ status: "ok", candidate: { name } })),
    },
  }) as unknown as RunRecord;

Deno.test("a place matches in either form, and only finished runs", () => {
  assert(inPlace(run("City of Fontana", []), "Fontana"));
  assert(inPlace(run("Fontana", []), "City of Fontana"));
  assert(!inPlace(run("Rialto", []), "Fontana"));
  assert(!inPlace(run("Fontana", [], "running"), "Fontana"));
});

Deno.test("finance fits a run only while it looks up the same candidates in the same order", () => {
  const a = subjectsOf(run("Fontana", ["Germaine Key", "Joe Alvanez"]));
  assertEquals(a, subjectsOf(run("City of Fontana", ["Germaine Key", "Joe Alvanez"])));
  assert(a !== subjectsOf(run("Fontana", ["Joe Alvanez", "Germaine Key"])));
});
