/**
 * Ballot Fix phase 0 CLI.
 *
 *   deno task dossier --city Fontana --office Mayor
 *   deno task dossier --city Fontana --office Mayor --candidates "A;B;C" --incumbent "B"
 *   deno task dossier --render out/fontana-mayor-2026-11-03.json
 */

import { parseArgs } from "@std/cli/parse-args";
import { AnthropicResearcher, DEFAULT_MODEL } from "./research/anthropic.ts";
import { contextForRace, raceContextFailed } from "./context.ts";
import { financeForRace, raceFinanceFailed } from "./finance.ts";
import { mergeRace } from "./merge.ts";
import { NetFileClient, NetFileResearcher, parseAgencyMap } from "./netfile.ts";
import { officeForRace, raceOfficeFailed } from "./office.ts";
import { runRace } from "./race.ts";
import { renderRace, slug } from "./render.ts";
import { parsePriorities } from "./dossier.ts";
import type { BallotCandidate, RaceDossier, RaceQuery } from "./types.ts";

const USAGE = `Usage:
  deno task dossier --city <city> [--state CA] [--office Mayor] [--election 2026-11-03]
                    [--candidates "Name A;Name B"] [--incumbent "Name A"]
                    [--priorities "housing costs;public safety"]
                    [--model ${DEFAULT_MODEL}] [--effort high] [--concurrency 3] [--out out]
                    [--no-shared] [--no-merge] [--no-context] [--no-finance] [--no-netfile]
                    [--no-powers]
  deno task dossier --render <saved.json> [--out out]

Writes <out>/<city>-<office>-<election>.json and .html. Before the candidates, one capped call
looks for pages that cover every candidate (the voter guide, a questionnaire, forum write-ups)
and puts them first in every candidate's research (--no-shared skips it). After research, one low-effort call
merges facts that several sources report into one (--no-merge skips it), and one more, with a
few capped web searches, adds short sourced notes on names in the facts (--no-context skips it).
A last capped call reads contributions off the candidates' campaign finance filings, so the page
can show who they share as contributors and endorsers (--no-finance skips it). Where the city's
filings are on NetFile, the contributions come straight from its public export instead, with no
model reading them (--no-netfile always uses the model; BALLOTFIX_NETFILE_AGENCIES="Oakland=COAK"
sets a place's agency by hand). One more capped
lookup says what the office can decide, its budget, seats, and term, and marks each of your
issues inside or outside its say (--no-powers skips it).
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
      "priorities",
      "model",
      "effort",
      "concurrency",
      "out",
      "render",
    ],
    boolean: ["help", "shared", "merge", "context", "finance", "netfile", "powers"],
    negatable: ["shared", "merge", "context", "finance", "netfile", "powers"],
    default: {
      shared: true,
      merge: true,
      context: true,
      finance: true,
      netfile: true,
      powers: true,
      state: "CA",
      office: "Mayor",
      election: "2026-11-03",
      out: "out",
      concurrency: "3",
    },
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

  const parsed = parsePriorities(args.priorities ?? "");
  if (!parsed.ok) {
    console.error(`--priorities: ${parsed.error}`);
    return 2;
  }
  const priorities = parsed.issues;

  const query: RaceQuery = {
    city: args.city,
    state: args.state.toUpperCase(),
    office: args.office,
    electionDate: args.election,
  };
  const researcher = new AnthropicResearcher({
    model: args.model,
    effort: effort as typeof EFFORTS[number],
    log: (m) => console.error(m),
  });

  let race = await runRace(query, researcher, {
    candidates: args.candidates ? parseCandidates(args.candidates, args.incumbent) : undefined,
    priorities,
    concurrency,
    shared: args.shared ? researcher : undefined,
    onProgress: (m) => console.error(m),
  });

  if (args.merge) {
    try {
      const merged = await mergeRace(race, researcher);
      race = merged.dossier;
      if (merged.sent) console.error(`Merged ${merged.groups} duplicate claim(s).`);
    } catch (err) {
      console.error(`Merging duplicate claims failed; writing them unmerged. ${err}`);
    }
  }

  if (args.context) {
    try {
      const c = await contextForRace(race, researcher);
      race = c.dossier;
      if (c.sent) console.error(`Wrote ${c.shown} context note(s) for ${c.sent} names.`);
      if (c.skipped) console.error(`${c.skipped} names not looked up (over the cap).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Context notes failed; the page lists the names without them. ${msg}`);
      race = raceContextFailed(race, msg);
    }
  }

  if (args.finance) {
    try {
      const money = args.netfile
        ? new NetFileResearcher({
          source: new NetFileClient(),
          fallback: researcher,
          agencies: parseAgencyMap(Deno.env.get("BALLOTFIX_NETFILE_AGENCIES")),
          log: (m) => console.error(m),
        })
        : researcher;
      const f = await financeForRace(race, money);
      race = f.dossier;
      if (f.sent) console.error(`Kept ${f.shown} contribution(s) from campaign finance filings.`);
      if (f.left_out) {
        console.error(`${f.left_out} contribution(s) listed but not kept (over the cap).`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Campaign finance lookup failed; the page says so for each candidate. ${msg}`);
      race = raceFinanceFailed(race, msg);
    }
  }

  if (args.powers) {
    try {
      const o = await officeForRace(race, researcher);
      race = o.dossier;
      console.error(`Looked up the office: ${o.shown} verified fact(s).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Office lookup failed; the page says so. ${msg}`);
      race = raceOfficeFailed(race, msg);
    }
  }

  const base = slug(`${query.city}-${query.office}-${query.electionDate}`);
  console.log(`Wrote ${await write(args.out, base, race)}`);
  const failed = race.candidates.filter((c) => c.status === "failed").length;
  if (failed) console.error(`${failed} candidate(s) failed; their sections say so on the page.`);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
