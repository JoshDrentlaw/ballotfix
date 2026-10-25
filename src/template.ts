/**
 * The fixed dossier template. Election invariant 1: every candidate in a race
 * gets these sections, in this order, with the same research instructions.
 * Changing this list changes it for everyone at once, by construction.
 */

export interface SectionSpec {
  id: string;
  title: string;
  /** Instruction given to the researcher for this section, identical for every candidate. */
  ask: string;
  /** Sections that only apply to someone currently holding the office. */
  incumbentOnly?: boolean;
}

export const SECTIONS = [
  {
    id: "background",
    title: "Who they are",
    ask:
      "Occupation, education, professional background, how long they have lived in the city, and any prior elected or appointed offices, with dates.",
  },
  {
    id: "record",
    title: "Record in this office",
    ask:
      "Only for the incumbent in this office: notable votes and actions, major projects approved or blocked, lawsuits against the city during their tenure, audits, and grand jury reports. For anyone else, record prior public offices under 'background' and leave this section empty with a gap_note saying they do not hold this office.",
    incumbentOnly: true,
  },
  {
    id: "accomplishments",
    title: "Accomplishments",
    ask:
      "Accomplishments claimed by the candidate or credited to them by others. For each, prefer a source that documents the outcome itself (a budget, a council action, an audit), not only the claim.",
  },
  {
    id: "criticisms",
    title: "Criticisms and controversies",
    ask:
      "Criticisms, controversies, legal or ethics issues, and failed or reversed initiatives. Search for these deliberately, with the same effort as accomplishments. Report who made each criticism.",
  },
  {
    id: "money",
    title: "Money and interests",
    ask:
      "Campaign fundraising and major contributors (California Form 460 or local equivalent), independent expenditures supporting or opposing them, and disclosed economic interests (Form 700 or equivalent).",
  },
  {
    id: "endorsements",
    title: "Endorsements and affiliations",
    ask:
      "Endorsements received, organizational affiliations, slates, and party affiliation where publicly stated (note that local offices are often nonpartisan).",
  },
  {
    id: "platform",
    title: "Stated platform",
    ask:
      "What the candidate says they will do, in their own words where possible: candidate statement in the county voter guide, campaign website, questionnaires, forums. Tag these as opinion or reported, since they are the candidate's own claims.",
  },
  {
    id: "community",
    title: "Community impact and local coverage",
    ask:
      "Reporting on this person's effect on specific neighborhoods or groups in the city, and what local outlets have covered about them in the last several years.",
  },
] as const satisfies readonly SectionSpec[];

export type SectionId = typeof SECTIONS[number]["id"];

export const SECTION_IDS: readonly SectionId[] = SECTIONS.map((s) => s.id);

/**
 * The fixed template for ballot measures. Same rules as SECTIONS: every
 * measure gets these, in this order. The case for and the case against carry
 * mirrored instructions (election invariant 4).
 */
export const MEASURE_SECTIONS = [
  {
    id: "effect",
    title: "What a yes or no vote does",
    ask:
      "What the measure would change if it passes, and what stays in place if it fails, from the official ballot label, the full text, and the impartial analysis (city attorney, county counsel, or for state measures the Legislative Analyst). Include its duration or sunset if any.",
  },
  {
    id: "history",
    title: "History",
    ask:
      "How it got on the ballot (council or board vote with the tally and date, citizen signature petition, or legislative vote), who drafted or sponsored it, the existing law or tax it changes, earlier versions or similar past measures here and how they did, and any litigation over it.",
  },
  {
    id: "people",
    title: "Who is for and against it",
    ask:
      "The proponents and the opponents: the people who signed the official ballot arguments on each side, the campaign committees, and the organizations behind each side. Say who each named person or group is (their role, office, employer, or affiliation) when a source says so. Search both sides with equal effort.",
  },
  {
    id: "money",
    title: "Money",
    ask:
      "Committees formed to support or oppose it, how much each has raised, and their largest contributors (California Form 410, 460, and 497 or local equivalent). Who would pay and who would receive money if it passes, when a source documents it.",
  },
  {
    id: "fiscal",
    title: "Cost and fiscal effect",
    ask:
      "The official fiscal analysis: cost or revenue estimates, tax rate and who pays it, where the money would go, and any oversight, audit, or spending restrictions written into it.",
  },
  {
    id: "case_for",
    title: "The case for, as supporters make it",
    ask:
      "The arguments supporters make, in their words where possible: the official argument in favor and rebuttal, campaign materials, and supporters quoted in coverage. Report who makes each argument. Tag these as opinion.",
  },
  {
    id: "case_against",
    title: "The case against, as opponents make it",
    ask:
      "The arguments opponents make, in their words where possible: the official argument against and rebuttal, campaign materials, and opponents quoted in coverage. Report who makes each argument. Tag these as opinion.",
  },
  {
    id: "coverage",
    title: "Endorsements and local coverage",
    ask:
      "Endorsements on each side (organizations, officials, editorial boards) and what local outlets have reported about the measure.",
  },
] as const satisfies readonly SectionSpec[];

export type MeasureSectionId = typeof MEASURE_SECTIONS[number]["id"];

export const MEASURE_SECTION_IDS: readonly MeasureSectionId[] = MEASURE_SECTIONS.map((s) => s.id);

/**
 * Issues the voter said matter most: a topic ("housing") or a stated view
 * ("protect abortion access"). Optional, and the same list applies to every
 * candidate in a race, so no one is checked against more than another. Each
 * issue is reported as its own section, with ids priority_1, priority_2, ...
 * A ballot-wide list and a per-contest list combine, up to MAX_PRIORITIES.
 */
export const MAX_PRIORITIES_PER_LIST = 5;
export const MAX_PRIORITIES = 8;
export const MAX_PRIORITY_LENGTH = 120;

export function priorityId(index: number): string {
  return `priority_${index + 1}`;
}

/** Shared by both templates: what to report for each issue, identically for everyone. */
export function priorityAsk(subject: "candidate" | "measure"): string {
  return subject === "candidate"
    ? "What this candidate has done, voted for, funded, said, or been endorsed or criticized for that bears on this issue, with the same effort for every candidate, and including anything that cuts against the stance you report."
    : "How this measure bears on this issue, as documented by the official analysis and as each side describes it, with equal effort for supporters' and opponents' claims.";
}

/** How to judge a stance, identically for everyone. Kept here beside the template. */
export function stanceAsk(subject: "candidate" | "measure"): string {
  const whose = subject === "candidate"
    ? "the candidate's documented record and statements"
    : "what a yes vote would do";
  return `Then judge the stance for each issue. If the voter's wording states a view (for example "protect abortion access" or "oppose new taxes"), compare ${whose} with that view: "conflicts" when the sourced facts clearly go against it, "aligns" when they clearly support it, "mixed" when they point both ways, "unclear" when the sourced facts are too thin to say. If the wording names only a topic with no view (for example "housing"), use "no_position". Base the stance only on facts you report in that issue's section, never on party labels, reputation, or guesses, and give a one-sentence basis that names those facts. Never combine stances into an overall judgment and never recommend a vote.`;
}
