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
