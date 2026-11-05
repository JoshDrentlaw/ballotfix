import { assert, assertEquals } from "@std/assert";
import { inPlace, losesRows, subjectsOf } from "../src/finance_cli.ts";
import type { FinanceResult } from "../src/types.ts";
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
  assert(!inPlace(run("Fontana", []), "Fontana", "WI"), "a Fontana in another state");
});

Deno.test("finance fits a run only while it looks up the same candidates in the same order", () => {
  const a = subjectsOf(run("Fontana", ["Germaine Key", "Joe Alvanez"]));
  assertEquals(a, subjectsOf(run("City of Fontana", ["Germaine Key", "Joe Alvanez"])));
  assert(a !== subjectsOf(run("Fontana", ["Joe Alvanez", "Germaine Key"])));
});

Deno.test("a result with fewer contributions for any subject is refused", () => {
  const f = (...n: number[]) =>
    ({
      subjects: n.map((k) => ({ contributions: Array(k).fill({}) })),
    }) as unknown as FinanceResult;
  assertEquals(losesRows(undefined, f(0, 0)), []);
  assertEquals(losesRows(f(0, 0), f(19, 19)), []);
  assertEquals(losesRows(f(3, 2), f(5, 0)), [1]);
});
