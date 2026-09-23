/**
 * Ballot Fix phase 0 CLI.
 *
 *   deno task dossier --city Fontana --office Mayor
 *   deno task dossier --city Fontana --office Mayor --candidates "A;B;C" --incumbent "B"
 *   deno task dossier --render out/fontana-mayor-2026-11-03.json
 */

import { parseArgs } from "@std/cli/parse-args";
import { AnthropicResearcher, DEFAULT_MODEL } from "./research/anthropic.ts";
import { runRace } from "./race.ts";
import { renderRace, slug } from "./render.ts";
import type { BallotCandidate, RaceDossier, RaceQuery } from "./types.ts";

const USAGE = `Usage:
  deno task dossier --city <city> [--state CA] [--office Mayor] [--election 2026-11-03]
                    [--candidates "Name A;Name B"] [--incumbent "Name A"]
                    [--model ${DEFAULT_MODEL}] [--effort high] [--concurrency 3] [--out out]
  deno task dossier --render <saved.json> [--out out]

Writes <out>/<city>-<office>-<election>.json and .html.
Needs ANTHROPIC_API_KEY in the environment or in .env (not needed for --render).`;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function parseCandidates(list: string, incumbent?: string): BallotCandidate[] {
  const inc = incumbent?.trim().toLowerCase();
  return list.split(";").map((n) => n.trim()).filter(Boolean).map((name) => ({
    name,
    ballot_designation: null,
    incumbent: inc !== undefined && name.toLowerCase() === inc,
  }));
}

async function write(dir: string, base: string, race: RaceDossier): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const html = `${dir}/${base}.html`;
  await Deno.writeTextFile(`${dir}/${base}.json`, JSON.stringify(race, null, 2));
  await Deno.writeTextFile(html, renderRace(race));
  return html;
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: [
      "city",
      "state",
      "office",
      "election",
      "candidates",
      "incumbent",
      "model",
      "effort",
      "concurrency",
      "out",
      "render",
    ],
    boolean: ["help"],
    default: { state: "CA", office: "Mayor", election: "2026-11-03", out: "out", concurrency: "3" },
  });
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.render) {
    const race = JSON.parse(await Deno.readTextFile(args.render)) as RaceDossier;
    const base = args.render.split("/").pop()!.replace(/\.json$/, "");
    console.log(`Wrote ${await write(args.out, base, race)}`);
    return 0;
  }

  if (!args.city) {
    console.error(USAGE);
    return 2;
  }
  if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("ANTHROPIC_AUTH_TOKEN")) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in .env or export it.");
    return 2;
  }
  const effort = args.effort ?? "high";
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    console.error(`--effort must be one of ${EFFORTS.join(", ")}`);
    return 2;
  }
  const concurrency = Number(args.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error("--concurrency must be a positive integer");
    return 2;
  }

  const query: RaceQuery = {
    city: args.city,
    state: args.state.toUpperCase(),
    office: args.office,
    electionDate: args.election,
  };
  const researcher = new AnthropicResearcher({
    model: args.model,
    effort: effort as typeof EFFORTS[number],
  });

  const race = await runRace(query, researcher, {
    candidates: args.candidates ? parseCandidates(args.candidates, args.incumbent) : undefined,
    concurrency,
    onProgress: (m) => console.error(m),
  });

  const base = slug(`${query.city}-${query.office}-${query.electionDate}`);
  console.log(`Wrote ${await write(args.out, base, race)}`);
  const failed = race.candidates.filter((c) => c.status === "failed").length;
  if (failed) console.error(`${failed} candidate(s) failed; their sections say so on the page.`);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
