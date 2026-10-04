/**
 * Builds examples/sample.html: a LAYOUT SAMPLE with placeholder candidates,
 * not research output. Run: deno run --allow-write=examples examples/build_sample.ts
 */
import { runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import { samplePort } from "./sample_data.ts";

const race = await runRace(
  { city: "Example City", state: "CA", office: "Mayor", electionDate: "2026-11-03" },
  samplePort(),
);
await Deno.writeTextFile(new URL("./sample.html", import.meta.url), renderRace(race));
console.log("Wrote examples/sample.html");
