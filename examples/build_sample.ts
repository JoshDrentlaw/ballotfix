/**
 * Builds examples/sample.html: a LAYOUT SAMPLE with placeholder candidates,
 * not research output. Run: deno run --allow-write=examples examples/build_sample.ts
 */
import { contextForRace } from "../src/context.ts";
import { financeForRace } from "../src/finance.ts";
import { mergeRace } from "../src/merge.ts";
import { runRace } from "../src/race.ts";
import { renderRace } from "../src/render.ts";
import {
  sampleContextWriter,
  sampleFinanceResearcher,
  sampleMerger,
  samplePort,
} from "./sample_data.ts";

const race = await runRace(
  { city: "Example City", state: "CA", office: "Mayor", electionDate: "2026-11-03" },
  samplePort(),
);
const { dossier: merged } = await mergeRace(race, sampleMerger());
const { dossier: noted } = await contextForRace(merged, sampleContextWriter());
const { dossier } = await financeForRace(noted, sampleFinanceResearcher());
await Deno.writeTextFile(new URL("./sample.html", import.meta.url), renderRace(dossier));
console.log("Wrote examples/sample.html");
