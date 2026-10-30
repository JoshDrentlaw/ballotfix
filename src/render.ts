/**
 * Renders a RaceDossier as one self-contained HTML page.
 *
 * Every string that came from research is untrusted: it is HTML-escaped, and
 * only http(s) URLs ever become links. The page has no scripts at all.
 */

import { attachNotes, MAX_CONTEXT_NAMES } from "./context.ts";
import { coveredSections, incumbencyNote, NOTHING_FOUND } from "./dossier.ts";
import {
  type BallotConnections,
  measureConnections,
  type PairConnections,
  raceConnections,
  SIDE_LABEL,
  type Tie,
} from "./finance.ts";
import { type EntityRef, keptApart, nameKey, noteRef, personRef, sideRef } from "./knowledge.ts";
import { MEASURE_SECTIONS, SECTIONS } from "./template.ts";
import type {
  CandidateDossier,
  ContextNote,
  ContextResult,
  Contribution,
  EvidenceType,
  Fact,
  FinanceResult,
  FinanceSubjectResult,
  MeasureDossier,
  OrderBasis,
  PriorityResult,
  RaceDossier,
  SectionResult,
  Stance,
  VoteMeanings,
} from "./types.ts";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Returns the URL only if it is http(s); anything else (javascript:, data:) is refused. */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export function link(url: string | null, text: string): string {
  const href = safeHref(url);
  return href
    ? `<a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">${esc(text)}</a>`
    : esc(text);
}

export function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

/** Ids the page uses itself; a candidate's anchor never takes one. */
const PAGE_IDS = new Set(["top", "glance", "shared", "mine", "new"]);

/**
 * Like slug, but keeps letters in any script: an anchor only has to work
 * in a link, not in a file name, so a name in Chinese or Arabic isn't
 * flattened to "x".
 */
function anchorSlug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "x";
}

/**
 * Each candidate's anchor on a race page, in ballot order: the readable
 * name when it is unique, else the name plus its ballot position, so two
 * names that read alike ("José García", "Jose Garcia") never share one.
 */
export function candidateAnchors(names: readonly string[]): string[] {
  const bases = names.map(anchorSlug);
  const used = new Set<string>(PAGE_IDS);
  return bases.map((b, i) => {
    const shared = bases.filter((x) => x === b).length > 1;
    let id = shared || b === "x" || used.has(b) ? `${b}-${i + 1}` : b;
    while (used.has(id)) id += `-${i + 1}`;
    used.add(id);
    return id;
  });
}

export const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  primary_record: "Primary record",
  reported: "Reported",
  opinion: "Opinion / claim",
  unsourced: "Unsourced",
};

const ORDER_LABEL: Record<OrderBasis, string> = {
  official_ballot_order: "Listed in official ballot order.",
  official_filing_list:
    "Listed in the order of the official candidate list, which may differ from the printed ballot.",
  unofficial: "Order is not from an official ballot. It is not a ranking.",
};

/** Source, author, and date, each said to be missing when it is. */
export function sourceMeta(
  c: { url: string; source_name: string; author: string | null; published: string | null },
): string {
  return [
    link(c.url, c.source_name),
    c.author ? `by ${esc(c.author)}` : "author not stated",
    c.published ? esc(publishedDate(c.published)) : "date not stated",
  ].join(" · ");
}

/** A full date reads like the rest of the page; a year or anything else stays as the source gave it. */
export function publishedDate(s: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? readableDate(s) : s;
}

function factMeta(f: Fact): string {
  return sourceMeta({ ...f, url: f.source_url });
}

/**
 * Links from a page the app serves into its entity pages. `href` answers
 * only for entities the run's own graph contribution holds. Exported and
 * downloaded pages never get one, so they stay self-contained.
 */
export interface EntityLinks {
  /** The run the page shows: part of some entity keys (personRef, contributorRef). */
  runId: string;
  href(key: string): string | null;
}

/**
 * Context notes the page shows next to names ([] for runs without them), and
 * where a named entity's page is, when the app serves the page.
 */
interface Notes {
  list: readonly ContextNote[];
  href?: (n: ContextNote) => string | null;
}

const NO_NOTES: Notes = { list: [] };

function notesFor(
  context: ContextResult | undefined,
  state: string,
  jurisdiction: string,
  links?: EntityLinks,
): Notes {
  const list = context?.notes ?? [];
  return links ? { list, href: (n) => links.href(noteRef(n, state, jurisdiction).key) } : { list };
}

/** The entity's name, linked to its page when there is one. */
function entityName(text: string, ref: EntityRef | null, links?: EntityLinks): string {
  const href = ref && links?.href(ref.key);
  return href ? `<a class="ent" href="${esc(href)}">${esc(text)}</a>` : esc(text);
}

function noteMeta(n: ContextNote): string {
  return [
    link(n.source_url, n.source_name),
    n.author ? `by ${esc(n.author)}` : "",
    n.published ? esc(publishedDate(n.published)) : "date not stated",
    n.reused_from
      ? `from an earlier lookup (${esc(publishedDate(n.reused_from.looked_up.slice(0, 10)))})`
      : "",
  ].filter(Boolean).join(" · ");
}

/**
 * A fact's statement, with a collapsed note after each name that has one
 * (src/context.ts). Without notes it is the plain paragraph it always was;
 * with them it is a div, since a <details> can't sit inside a <p>.
 */
function statementHtml(statement: string, notes: Notes): string {
  const pieces = attachNotes(statement, notes.list);
  if (pieces.every((p) => typeof p === "string")) return `<p>${esc(statement)}</p>`;
  // Punctuation right after a name stays with it, not alone under an open note.
  const stuck = (i: number) => {
    const next = pieces[i + 1];
    return typeof next === "string" ? next.match(/^[.,;:!?)\]"'”’]+/)?.[0] ?? "" : "";
  };
  return `<div class="st">${
    pieces.map((p, i) =>
      typeof p === "string"
        ? esc(i > 0 ? p.slice(stuck(i - 1).length) : p)
        : `<span class="named">${
          namedText(p.text, p.note, notes) + esc(stuck(i))
        }</span><details class="ctx"><summary aria-label="${
          p.note.kind === "person" ? "Who is" : "What is"
        } ${esc(p.text)}?">${
          p.note.kind === "person" ? "who?" : "what?"
        }</summary><span class="ctx-body">${esc(p.note.note)} <span class="meta">${
          noteMeta(p.note)
        }</span></span></details>`
    ).join("")
  }</div>`;
}

/** A name with a note: a link to its entity page when the app serves the page and has one. */
function namedText(text: string, n: ContextNote, notes: Notes): string {
  const href = notes.href?.(n);
  return href ? `<a class="ent" href="${esc(href)}">${esc(text)}</a>` : esc(text);
}

/**
 * One fact. A merged one (src/merge.ts) shows once, with every outlet that
 * reported it and, collapsed, how each of the others worded it.
 */
function factItem(f: Fact, notes: Notes = NO_NOTES): string {
  const also = f.also ?? [];
  const tag = evTag(f.evidence_type);
  if (!also.length) {
    return `<li class="fact">
  ${tag}
  ${statementHtml(f.statement, notes)}
  <p class="meta">${factMeta(f)}</p>
</li>`;
  }
  return `<li class="fact merged">
  ${tag} <span class="nsrc">Reported by ${also.length + 1} sources</span>
  ${statementHtml(f.statement, notes)}
  <ul class="meta srcs">${[f, ...also].map((x) => `<li>${factMeta(x)}</li>`).join("")}</ul>
  <details class="wording"><summary>How each source put it</summary><ul>${
    [f, ...also].map((x) =>
      `<li><span class="src">${esc(x.source_name)}:</span> ${esc(x.statement)}</li>`
    )
      .join("")
  }</ul></details>
</li>`;
}

function evTag(t: EvidenceType): string {
  return `<span class="ev ev-${t}">${EVIDENCE_LABEL[t]}</span>`;
}

/** Where a fact already shown in full on this page is, by the same source and words. */
type Shown = Map<string, { id: string; label: string }>;

const shownKey = (f: Fact) => `${f.source_url}\n${f.statement.trim().toLowerCase()}`;

/**
 * A fact that also backs one of the voter's issues, which come first and show
 * it in full. Here it keeps its words and every source of its own (a merge in
 * this section may have joined outlets the issue's copy doesn't have), and
 * links to the rest.
 */
function refItem(f: Fact, at: { id: string; label: string }, notes: Notes): string {
  const also = f.also ?? [];
  const jump = `<a class="jumpto" href="#${esc(at.id)}">Shown in full under “${esc(at.label)}”</a>`;
  const sources = also.length
    ? `<ul class="meta srcs">${
      [f, ...also].map((x) => `<li>${factMeta(x)}</li>`).join("")
    }</ul><p class="meta">${jump}</p>`
    : `<p class="meta">${factMeta(f)} · ${jump}</p>`;
  return `<li class="fact ref">
  ${evTag(f.evidence_type)}
  ${statementHtml(f.statement, notes)}
  ${sources}
</li>`;
}

/**
 * The id a section gets on the page, so the overview grid can link to it.
 * `anchor` is the candidate's (candidateAnchors) or "m" for a measure; it
 * never holds "--", so section ids can't collide across candidates.
 */
export function sectionAnchor(anchor: string, sectionId: string): string {
  return `${anchor}--${sectionId.replace(/_/g, "-")}`;
}

/** How a section is drawn: its heading level, what goes under it, its id, and facts shown elsewhere. */
interface SectionOptions {
  tag?: string;
  between?: string;
  id?: string;
  shown?: Shown;
}

/** Runs saved before a section was added to the template don't have it. */
const NOT_IN_THIS_RUN: SectionResult = {
  facts: [],
  searched: [],
  gap_note: "This section was added after this run; research again to fill it.",
};

/** What each section of a failed subject says, after the reason is given once above them. */
const NOT_CHECKED = "Not checked.";

/**
 * A failed subject's sections all carry the same failure note. It is said once,
 * above them, and each section keeps its place saying only that it wasn't
 * checked, so a failed subject doesn't take more room than one with findings.
 */
function failedNote(
  failed: boolean,
  sections: Readonly<Record<string, SectionResult | undefined>>,
): { note: string; section: (r: SectionResult | undefined) => SectionResult | undefined } {
  const said = failed
    ? Object.values(sections).find((r) => r && !r.facts.length && r.gap_note)?.gap_note
    : undefined;
  if (!said) return { note: "", section: (r) => r };
  return {
    note: `<p class="note">${esc(said)} Every section below keeps its place.</p>`,
    section: (r) =>
      r && !r.facts.length && r.gap_note === said ? { ...r, gap_note: NOT_CHECKED } : r,
  };
}

/**
 * A section's facts, gap note, and what was searched. A section with nothing
 * found keeps its place in the template and says so, drawn compact so it
 * doesn't take the room of one with findings.
 */
function sectionHtml(
  title: string,
  r: SectionResult | undefined,
  notes: Notes,
  o: SectionOptions = {},
): string {
  r ??= NOT_IN_THIS_RUN;
  const tag = o.tag ?? "h4";
  const id = o.id ? ` id="${esc(o.id)}"` : "";
  const facts = r.facts.length
    ? `<ul class="facts">${
      r.facts.map((f) => {
        const at = o.shown?.get(shownKey(f));
        return at ? refItem(f, at, notes) : factItem(f, notes);
      }).join("")
    }</ul>`
    : "";
  // The usual empty note is said briefly, so it fits beside the heading.
  const gapText = !r.facts.length && r.gap_note === NOTHING_FOUND
    ? "Nothing this run could source."
    : r.gap_note;
  const gap = gapText ? `<p class="gap">${esc(gapText)}</p>` : "";
  const searched = r.searched.length
    ? `<p class="searched">Looked at: ${r.searched.map(esc).join("; ")}</p>`
    : "";
  const empty = !r.facts.length && !o.between ? " empty" : "";
  return `<section class="sec${empty}"${id}><${tag}>${esc(title)}</${tag}>${
    o.between ?? ""
  }${facts}${gap}${searched}</section>`;
}

/**
 * What a yes vote and a no vote each mean, side by side above the effect
 * section's facts. Both are drawn the same way, in the same neutral colors:
 * red and green belong to stance alone, and neither vote gets one.
 */
function voteMeansHtml(v: VoteMeanings | undefined, notes: Notes): string {
  if (!v) {
    return `<p class="gap">A plain summary of what a yes and a no vote mean was added after this run; research again to get it.</p>`;
  }
  const one = (label: string, f: Fact | null) =>
    f
      ? `<div class="vote"><p class="vote-label">${label}</p>${
        statementHtml(f.statement, notes)
      }<p class="meta">${evTag(f.evidence_type)} ${factMeta(f)}</p></div>`
      : `<div class="vote"><p class="vote-label">${label}</p><p class="gap">No page this run opened says this in plain terms. See the facts below.</p></div>`;
  return `<div class="votes">${one("YES", v.yes)}${one("NO", v.no)}</div>`;
}

/** How much of the template a finished candidate's research found sources for. */
export function coverageLine(d: CandidateDossier): string {
  return `<p class="cov">Sourced facts found in ${
    coveredSections(d)
  } of ${SECTIONS.length} sections.</p>`;
}

function overviewCard(d: CandidateDossier, anchor: string): string {
  const c = d.candidate;
  const status = d.status === "failed"
    ? `<p class="cov cov-fail">Research failed in this run. Nothing about this candidate was checked.</p>`
    : d.status === "pending"
    ? `<p class="cov cov-pending">Researching now…</p>`
    : coverageLine(d);
  return `<li class="card">
  <h3><a href="#${anchor}">${esc(c.name)}</a></h3>
  <p class="desig">${
    c.ballot_designation ? esc(c.ballot_designation) : "Ballot designation not found"
  }${c.incumbent ? ` · <span class="inc">Incumbent</span>` : ""}</p>
  ${d.status === "ok" ? stanceSummary(d.priorities, "candidate") : ""}
  ${status}
</li>`;
}

type Subject = "candidate" | "measure";

/** Labels for the stance on a voter's issue. Undefined for topic-only issues and old runs. */
function stanceLabel(st: Stance | undefined, subject: Subject): string | null {
  const measure = subject === "measure";
  switch (st) {
    case "conflicts":
      return measure ? "A yes vote conflicts with your view" : "Conflicts with your view";
    case "aligns":
      return measure ? "A yes vote matches your view" : "Matches your view";
    case "mixed":
      return "Mixed record on your view";
    case "unclear":
      return "Not enough on record to say";
    default:
      return null;
  }
}

function stanceBadge(x: PriorityResult, subject: Subject): string {
  const label = stanceLabel(x.stance, subject);
  if (!label) return "";
  const basis = x.stance_basis ? ` <span class="basis">${esc(x.stance_basis)}</span>` : "";
  return `<p class="stance stance-${x.stance}"><strong>${esc(label)}.</strong>${basis}</p>`;
}

/** The voter's own issues, first, so what they asked about is what they see first. */
function prioritiesHtml(
  p: readonly PriorityResult[] | undefined,
  subject: Subject,
  notes: Notes,
  anchor: string,
  section: (r: SectionResult) => SectionResult | undefined = (r) => r,
): string {
  if (!p?.length) return "";
  return `<section class="priorities"><h4>On what you said matters to you</h4>${
    p.map((x, i) =>
      sectionHtml(x.issue, section(x.result), notes, {
        tag: "h5",
        between: stanceBadge(x, subject),
        id: sectionAnchor(anchor, `priority_${i + 1}`),
      })
    ).join("")
  }</section>`;
}

/** Facts the voter's issues show in full, so the template sections can point to them. */
function shownInPriorities(p: readonly PriorityResult[] | undefined, anchor: string): Shown {
  const shown: Shown = new Map();
  (p ?? []).forEach((x, i) => {
    for (const f of x.result.facts) {
      const k = shownKey(f);
      if (!shown.has(k)) {
        shown.set(k, { id: sectionAnchor(anchor, `priority_${i + 1}`), label: x.issue });
      }
    }
  });
  return shown;
}

/**
 * The quick read on the overview: which of the voter's stated views the
 * record conflicts with or matches, conflicts first. Same rule for everyone.
 */
export function stanceSummary(p: readonly PriorityResult[] | undefined, subject: Subject): string {
  const of = (st: Stance) => (p ?? []).filter((x) => x.stance === st).map((x) => esc(x.issue));
  const lines: [Stance, string[]][] = [
    ["conflicts", of("conflicts")],
    ["mixed", of("mixed")],
    ["aligns", of("aligns")],
  ];
  return lines.filter(([, issues]) => issues.length).map(([st, issues]) =>
    `<p class="stance stance-${st}"><strong>${esc(stanceLabel(st, subject)!)}:</strong> ${
      issues.join("; ")
    }</p>`
  ).join("");
}

function gapsAndUnverified(
  gaps: readonly string[],
  unverified: readonly Fact[],
  notes: Notes,
): string {
  const g = gaps.length
    ? `<section class="sec"><h4>What this run couldn't check</h4><ul class="gaps">${
      gaps.map((x) => `<li>${esc(x)}</li>`).join("")
    }</ul></section>`
    : "";
  const u = unverified.length
    ? `<details class="unverified"><summary>${unverified.length} claim${
      unverified.length === 1 ? "" : "s"
    } not shown above because the cited page was never retrieved in this run</summary>
<p>These cite a URL the research session did not actually open, so they can't be traced. Treat them as leads to check yourself, not findings.</p>
<ul class="facts">${unverified.map((f) => factItem(f, notes)).join("")}</ul></details>`
    : "";
  return g + u;
}

/**
 * What the context step did for this page: how notes work, and every name it
 * couldn't describe or never looked up, so a missing note is never silent.
 * Nothing for runs from before the step, or where it didn't run.
 */
function namesHtml(c: ContextResult | undefined): string {
  if (!c) return "";
  const shown = c.notes.filter((n) => n.verified);
  const unverified = c.notes.filter((n) => !n.verified);
  const list = (names: readonly string[]) => names.map(esc).join("; ");
  const parts = [
    c.error
      ? `<p class="gap">Notes on these names couldn't be written in this run (${esc(c.error)}).${
        shown.some((n) => n.reused_from)
          ? " The notes shown come from an earlier run in this place that retrieved a page for the same name, as each note says."
          : ""
      }</p>`
      : `<p>Names were picked out of the facts automatically, so some may be missed.${
        shown.length
          ? ` A <span class="ctx-eg">who?</span> or <span class="ctx-eg">what?</span> after a name opens a one-line note on who or what it is, from a page this run retrieved${
            shown.some((n) => n.reused_from)
              ? ", or, where the note says so, one an earlier run in this place retrieved for the same name"
              : ""
          }. Notes describe; they don't evaluate.`
          : ""
      } Every name was looked up the same way, whichever candidate or side it came up for.${
        shown.some((n) => n.reused_from)
          ? " A name an earlier run in this place already described reuses that note instead of being looked up again, whoever it came up for, so names researched before are more likely to have one."
          : ""
      }</p>`,
    c.not_described.length
      ? `<p><strong>No sourced note found for:</strong> ${list(c.not_described)}.</p>`
      : "",
    c.not_needed?.length
      ? `<p><strong>No note needed</strong> (not a specific person or organization, or widely known), as judged by the research model: ${
        list(c.not_needed)
      }.</p>`
      : "",
    c.not_looked_up.length
      ? `<p><strong>Not looked up</strong>${
        c.error ? "" : ` (each run looks up at most ${MAX_CONTEXT_NAMES} names, shared equally)`
      }: ${list(c.not_looked_up)}.</p>`
      : "",
    unverified.length
      ? `<details class="unverified"><summary>${unverified.length} note${
        unverified.length === 1 ? "" : "s"
      } not shown because the cited page was never retrieved</summary><ul class="facts">${
        unverified.map((n) =>
          `<li class="fact"><p><strong>${esc(n.name)}:</strong> ${esc(n.note)}</p><p class="meta">${
            noteMeta(n)
          }</p></li>`
        ).join("")
      }</ul></details>`
      : "",
  ].filter(Boolean);
  return `<section class="sec names"><h4>Names in these facts</h4>${parts.join("")}</section>`;
}

// ---------------------------------------------------------------------------
// Campaign finance (src/finance.ts)
// ---------------------------------------------------------------------------

const PORTAL_PROBLEM_LABEL = {
  scanned_pdf: "scanned PDF with no readable text",
  login_required: "needs a login",
  javascript_only: "only works with JavaScript",
  not_found: "no filings found online",
  other: "couldn't be read",
} as const;

/** "Contractor, Acme Builders" for an individual, when the record states either. */
function work(c: Contribution): string {
  const w = [c.occupation, c.employer].filter(Boolean).join(", ");
  return w ? `<span class="desig">${esc(w)}</span>` : "";
}

/** Alphabetical by contributor: the order says nothing about who gave most. */
const alphabetical = (cs: readonly Contribution[]) =>
  [...cs].sort((a, b) => nameKey(a.contributor).localeCompare(nameKey(b.contributor)));

const filingKey = (c: Contribution) =>
  [c.filer, c.filing_period, c.filing, c.source_name, c.source_url].join("\n");

/**
 * Contributions as tables, one per filing they were read from, so the
 * filer, period, form, and source are said once above the rows that share
 * them. Every field is the record's own words; nothing is added up.
 */
function giftTables(cs: readonly Contribution[]): string {
  const groups = new Map<string, Contribution[]>();
  for (const c of alphabetical(cs)) {
    const k = filingKey(c);
    groups.set(k, [...groups.get(k) ?? [], c]);
  }
  return [...groups.values()].map((rows) => {
    const c = rows[0];
    return `<div class="gift-group"><p class="meta">To ${esc(c.filer)} · ${
      c.filing_period ? esc(c.filing_period) : "filing period not stated"
    }${c.filing ? ` · ${esc(c.filing)}` : ""} · ${link(c.source_url, c.source_name)}</p>
<table class="gifts"><thead><tr><th scope="col">Contributor</th><th scope="col" class="num">Amount</th><th scope="col">Date</th></tr></thead><tbody>${
      rows.map((r) =>
        `<tr><th scope="row">${esc(r.contributor)}${work(r)}</th><td class="num">${
          esc(r.amount)
        }</td><td class="date">${r.date ? esc(r.date) : "not stated"}</td></tr>`
      ).join("")
    }</tbody></table></div>`;
  }).join("");
}

/**
 * One candidate's or side's money, the same block for everyone, including a
 * subject with nothing found (its gap note). Nothing for runs from before the
 * step, or where it didn't run.
 */
function moneyHtml(
  finance: FinanceResult | undefined,
  s: FinanceSubjectResult | undefined,
  title: string,
  titleHtml = esc(title),
  anchor?: string,
): string {
  if (!finance) return "";
  const id = anchor ? ` id="${esc(anchor)}"` : "";
  if (!s) {
    return `<section class="sec money empty"${id}><h4>${titleHtml}</h4><p class="gap">Not looked up in this run.</p></section>`;
  }
  const totals = s.totals.length
    ? `<ul class="meta totals">${
      s.totals.map((t) =>
        `<li>${esc(t.filer)}, ${esc(t.label)}: <strong>${esc(t.amount)}</strong>${
          t.filing_period ? ` (${esc(t.filing_period)})` : ""
        } · ${link(t.source_url, t.source_name)}</li>`
      ).join("")
    }</ul>`
    : "";
  // Folded the same way for every subject, so nobody's money is more or less in view.
  const n = s.contributions.length;
  const filings = new Set(s.contributions.map(filingKey)).size;
  const gifts = n
    ? `<details class="fold"><summary>${n} contribution${
      n === 1 ? "" : "s"
    } from ${filings} filing${filings === 1 ? "" : "s"}</summary>${
      giftTables(s.contributions)
    }</details>`
    : "";
  const notes = [
    s.gap_note ? `<p class="gap">${esc(s.gap_note)}</p>` : "",
    s.not_listed ? `<p class="gap">The filings list more: ${esc(s.not_listed)}</p>` : "",
    s.left_out.length
      ? `<p class="gap">Not kept (each run keeps at most ${finance.per_subject} per ${
        s.side ? "side" : "candidate"
      }, the same for everyone): ${s.left_out.map(esc).join("; ")}.</p>`
      : "",
    s.dropped
      ? `<p class="gap">${s.dropped} more row${
        s.dropped === 1 ? "" : "s"
      } came back incomplete, repeated, or past the limit without a retrieved page, and aren't shown.</p>`
      : "",
    s.committees.length
      ? `<p class="searched">Committees looked at: ${s.committees.map(esc).join("; ")}</p>`
      : "",
    s.searched.length ? `<p class="searched">Looked at: ${s.searched.map(esc).join("; ")}</p>` : "",
  ].join("");
  const unverified = s.unverified.length
    ? `<details class="unverified"><summary>${s.unverified.length} contribution${
      s.unverified.length === 1 ? "" : "s"
    } not shown because the cited page was never retrieved</summary><p>Treat these as leads to check at the filing portal yourself. They aren't counted as shared connections.</p>${
      giftTables(s.unverified)
    }</details>`
    : "";
  return `<section class="sec money"${id}><h4>${titleHtml}</h4>
<p class="sub">Itemized contributions read from campaign finance filings, each as the record states it, alphabetical by contributor.</p>
${totals}${gifts}${notes}${unverified}</section>`;
}

/** The filing portals this run couldn't read: coverage gaps, shown, not collapsed. */
function portalGapsHtml(finance: FinanceResult | undefined): string {
  if (!finance) return "";
  const lines = [
    finance.error
      ? `<li>The campaign finance lookup failed in this run (${esc(finance.error)}).</li>`
      : "",
    ...finance.portal_gaps.map((g) =>
      `<li>${link(g.url, g.portal)}: ${PORTAL_PROBLEM_LABEL[g.problem]}.${
        g.note ? ` ${esc(g.note)}` : ""
      }</li>`
    ),
  ].filter(Boolean);
  return lines.length
    ? `<section class="sec"><h4>Campaign finance this run couldn't read</h4><ul class="gaps">${
      lines.join("")
    }</ul></section>`
    : "";
}

export const SUPPORT_TITLE: Record<string, string> = {
  endorsements: "Endorsements and affiliations",
  case_for: "The case for",
  case_against: "The case against",
};

function tieHtml(label: string, t: Tie): string {
  const who = `<span class="who-tag">${esc(label)}:</span> `;
  if (t.kind === "contribution") {
    const c = t.contribution;
    return `<li>${who}contribution of ${esc(c.amount)}, ${
      c.date ? esc(c.date) : "date not stated"
    }, to ${esc(c.filer)}${c.filing_period ? ` (${esc(c.filing_period)})` : ""} · ${
      link(c.source_url, c.source_name)
    }</li>`;
  }
  const more = t.fact.also?.length ? ` and ${t.fact.also.length} more` : "";
  return `<li>${who}named in ${esc(SUPPORT_TITLE[t.section] ?? t.section)}: “${
    esc(t.fact.statement)
  }” · ${link(t.fact.source_url, t.fact.source_name)}${more}</li>`;
}

function kindLabel(key: string, kind: string): string {
  const kept = keptApart(key);
  return kept === "row" || kept === "work" ? "individual" : kind;
}

/** One shared entity: its name (linked when the app has a page for it), kind, and every tie. */
function sharedEntryHtml(ref: EntityRef, ties: readonly string[], links?: EntityLinks): string {
  return `<li><strong>${entityName(ref.name, ref, links)}</strong> <span class="desig">${
    kindLabel(ref.key, ref.kind)
  }</span><ul class="ties">${ties.join("")}</ul></li>`;
}

/** A pair's fold says how many it shares and how many near misses it lists: counts, never a score. */
export function pairCount(p: { shared: readonly unknown[]; possible: readonly unknown[] }): string {
  const parts = [
    p.shared.length ? `${p.shared.length} shared` : "none shared",
    p.possible.length ? `${p.possible.length} possibly the same` : "",
  ].filter(Boolean);
  return ` <span class="desig">${parts.join(" · ")}</span>`;
}

function possibleHtml(p: PairConnections): string {
  return p.possible.map((m) =>
    `<p class="gap">Possibly the same, kept separate because the names or details don't match exactly: ${
      m.a.map(esc).join(" / ")
    } (${esc(p.a)}) and ${m.b.map(esc).join(" / ")} (${esc(p.b)}).</p>`
  ).join("");
}

/**
 * Who each pair shares as a contributor or endorser, each tie with its
 * source. Collapsed. Every pair gets its own block in ballot order, one with
 * nothing shared saying so: pairs are never grouped or ordered by what they
 * share. Nothing is scored or ranked.
 */
function sharedHtml(
  pairs: readonly PairConnections[],
  finance: FinanceResult | undefined,
  context: ContextResult | undefined,
  place: string,
  single: string,
  links?: EntityLinks,
): string {
  const caveats = [
    !finance
      ? "Campaign finance filings weren't looked up in this run, so only endorsements are compared."
      : finance.error
      ? "Campaign finance filings couldn't be looked up in this run, so only endorsements are compared."
      : "",
    !context?.notes.some((n) => n.verified)
      ? "No names in this run's facts have a sourced note, so endorsements can't be matched by name."
      : "",
  ].filter(Boolean).map((c) => `<p class="gap">${esc(c)}</p>`).join("");
  const blocks = pairs.map((p) =>
    `<details class="pair"><summary><h5>${esc(p.a)} and ${esc(p.b)}${pairCount(p)}</h5></summary>${
      p.shared.length
        ? `<ul class="shared-list">${
          p.shared.map((x) =>
            sharedEntryHtml(
              x.ref,
              [
                ...x.a.map((t) => tieHtml(p.a, t)),
                ...x.b.map((t) =>
                  tieHtml(p.b, t)
                ),
              ],
              links,
            )
          ).join("")
        }</ul>`
        : `<p class="gap">No shared contributors or endorsers found.</p>`
    }${possibleHtml(p)}</details>`
  ).join("");
  const body = pairs.length ? blocks : `<p class="gap">${esc(single)}</p>`;
  const sharing = pairs.filter((p) => p.shared.length).length;
  return `<details class="shared sec" id="shared"><summary>Shared connections (${
    sharing
      ? `${sharing} of ${pairs.length} pair${pairs.length === 1 ? "" : "s"} ${
        sharing === 1 ? "shares" : "share"
      } someone`
      : "none found"
  })</summary>
<p>For each pair, the contributors and endorsers both have, each with its source. A contributor counts only from a filing this run retrieved; an endorser only where a fact names someone with a sourced note. They are matched within ${
    esc(place)
  } by exact name and kind, and an individual also by the same stated occupation and employer, so close names are kept separate rather than guessed. A shared name is a connection to look into, not a judgment of anyone.</p>
${caveats}${body}</details>`;
}

/**
 * Who candidates and sides of different items on one ballot share, for the
 * ballot's Researched tab (ballotConnections). Collapsed. Entities are
 * alphabetical and each lists its holders in ballot order, each tie with its
 * source; nothing is counted up or ranked. `href` links an entity key to its
 * page when the app has one.
 */
export function ballotSharedHtml(
  c: BallotConnections,
  href?: (key: string) => string | null,
  /** Researched items left out because their research isn't done: headings, in ballot order. */
  notCompared: readonly string[] = [],
): string {
  // Sharing across items needs two items; within one, it is that item's own page's.
  if (c.items < 2) return "";
  const links = href ? { runId: "", href } : undefined;
  const list = c.shared.length
    ? `<ul class="shared-list">${
      c.shared.map((x) =>
        sharedEntryHtml(
          x.ref,
          x.holders.flatMap((h) => h.ties.map((t) => tieHtml(`${h.item} · ${h.label}`, t))),
          links,
        )
      ).join("")
    }</ul>`
    : `<p class="gap">No contributor or endorser is tied to more than one item.</p>`;
  const gaps = [
    ...(notCompared.length
      ? [`Not compared, because their research isn't done: ${notCompared.join("; ")}.`]
      : []),
    ...c.gaps.map((g) => `${g.item}: ${g.why}.`),
  ].map((g) => `<p class="gap">${esc(g)}</p>`).join("");
  const possible = c.possible.map((group) =>
    `<p class="gap">Possibly the same, kept separate because the names, details, or places don't match exactly: ${
      group.map((x) => `${esc(x.name)} (${esc(x.item)} · ${esc(x.label)})`).join(" / ")
    }.</p>`
  ).join("");
  return `<details class="shared sec" id="shared"><summary>Shared across this ballot (${
    c.shared.length ? `${c.shared.length} found` : "none found"
  })</summary>
<p>Contributors and endorsers tied to candidates or sides in more than one item on this ballot, each tie with its source. They are matched the way each race page matches them: a contributor only from a filing that run retrieved, an endorser only where a fact names someone with a sourced note, by exact name and kind, and an individual also by the same stated occupation and employer.${
    c.places > 1
      ? ` These items are in ${c.places} different places (city, county, district, or state), and names are only matched within one place, so the same group in two places is listed under possible matches instead.`
      : ""
  } Sharing within one contest or measure is on its own page. A shared name is a connection to look into, not a judgment of anyone.</p>
${gaps}${list}${possible}</details>`;
}

function dossierSection(
  d: CandidateDossier,
  anchor: string,
  notes: Notes,
  next?: { d: CandidateDossier; anchor: string },
  finance?: FinanceResult,
  money?: FinanceSubjectResult,
  person?: { ref: EntityRef; links: EntityLinks },
): string {
  const c = d.candidate;
  if (d.status === "pending") {
    return `<article class="dossier pending" id="${anchor}">
  <h2 class="dossier-name">${esc(c.name)}</h2>
  <p class="gap">Research on this candidate is still running. This page updates on its own.</p>
</article>`;
  }
  const shown = shownInPriorities(d.priorities, anchor);
  const failed = failedNote(d.status === "failed", d.sections);
  const sections = SECTIONS.map((s) =>
    sectionHtml(s.title, failed.section(d.sections[s.id]), notes, {
      id: sectionAnchor(anchor, s.id),
      shown,
    })
  ).join("");

  const identity = d.identity_note
    ? `<p class="note"><strong>Identity check.</strong> ${esc(d.identity_note)}</p>`
    : "";

  return `<article class="dossier" id="${anchor}">
  <h2 class="dossier-name">${entityName(c.name, person?.ref ?? null, person?.links)}</h2>
  <p class="desig dossier-desig">${
    c.ballot_designation ? esc(c.ballot_designation) : "Ballot designation not found"
  }${c.incumbent ? ` · <span class="inc">Incumbent</span>` : ""}</p>
  ${identity}
  ${failed.note}
  ${prioritiesHtml(d.priorities, "candidate", notes, anchor, failed.section)}
  ${sections}
  ${moneyHtml(finance, money, "Contributions on file", undefined, sectionAnchor(anchor, "filed"))}
  ${gapsAndUnverified(d.gaps, d.unverified, notes)}
  <p class="back"><a href="#glance">Back to the overview</a>${
    next ? ` · <a href="#${next.anchor}">Next: ${esc(next.d.candidate.name)}</a>` : ""
  }</p>
</article>`;
}

/** Short stance words for the overview grid; the full label is in each dossier. */
const STANCE_SHORT: Record<Exclude<Stance, "no_position">, string> = {
  conflicts: "Conflicts",
  aligns: "Matches",
  mixed: "Mixed",
  unclear: "Unclear",
};

/** One cell: a link to the section when it holds anything, else a quiet dash that says why. */
function glanceCell(n: number, href: string, none: string): string {
  return n
    ? `<td><a href="#${esc(href)}">${n}</a></td>`
    : `<td class="none"><span aria-hidden="true">–</span><span class="vh">${esc(none)}</span></td>`;
}

/**
 * Every candidate against every section, in ballot order: how many sourced
 * facts each section holds, each a link into the dossier, and the stance on
 * each of the voter's issues. It shows where to look, nothing more. Rows are
 * the template, so every candidate gets the same rows; nothing is totaled.
 */
function glanceHtml(r: RaceDossier, anchors: readonly string[]): string {
  const ds = r.candidates;
  const at = (d: CandidateDossier) => anchors[ds.indexOf(d)];
  if (ds.length < 2) return "";
  const head = ds.map((d) =>
    `<th scope="col"><a href="#${at(d)}">${esc(d.candidate.name)}</a>${
      d.status === "failed"
        ? `<span class="inc-mark cov-fail">Research failed</span>`
        : d.status === "pending"
        ? `<span class="inc-mark">Researching…</span>`
        : d.candidate.incumbent
        ? `<span class="inc-mark">Incumbent</span>`
        : ""
    }</th>`
  ).join("");
  const unfinished = (d: CandidateDossier) =>
    d.status === "failed"
      ? `<td class="none"><span aria-hidden="true">–</span><span class="vh">research failed</span></td>`
      : d.status === "pending"
      ? `<td class="none">…</td>`
      : null;
  // Money is looked up for a failed candidate too, so only pending hides it.
  const row = (label: string, cell: (d: CandidateDossier) => string, evenIfFailed = false) =>
    `<tr><th scope="row">${esc(label)}</th>${
      ds.map((d) => (evenIfFailed && d.status === "failed" ? null : unfinished(d)) ?? cell(d)).join(
        "",
      )
    }</tr>`;
  const issues = (r.priorities ?? []).map((issue, i) =>
    row(issue, (d) => {
      const x = d.priorities?.[i];
      const id = sectionAnchor(at(d), `priority_${i + 1}`);
      if (!x) return `<td class="none">–</td>`;
      if (x.stance && x.stance !== "no_position") {
        return `<td><a class="stance-${x.stance}" href="#${esc(id)}">${
          STANCE_SHORT[x.stance]
        }</a></td>`;
      }
      return glanceCell(x.result.facts.length, id, "nothing found");
    })
  );
  const sections = SECTIONS.map((s) =>
    row(s.title, (d) => {
      const n = d.sections[s.id]?.facts.length ?? 0;
      // A non-incumbent's section is n/a only when it is empty: facts found there still show.
      const notHeld = "incumbentOnly" in s && s.incumbentOnly && !d.candidate.incumbent;
      return notHeld && !n
        ? `<td class="none">n/a</td>`
        : glanceCell(n, sectionAnchor(at(d), s.id), "nothing found");
    })
  );
  const money = r.finance
    ? [row("Contributions on file", (d) => {
      const i = ds.indexOf(d);
      const m = r.finance!.subjects.find((x) => x.candidate === i);
      return glanceCell(
        m?.contributions.length ?? 0,
        sectionAnchor(at(d), "filed"),
        m ? "none found" : "not looked up",
      );
    }, true)]
    : [];
  const issueHead = issues.length
    ? `<tr class="group"><th scope="rowgroup" colspan="${ds.length + 1}">Your issues</th></tr>`
    : "";
  return `<section class="glance" id="glance"><h2>At a glance</h2>
<p class="sub">Sourced facts found in each section, as links into each dossier${
    issues.length ? ", and the reading on each of your issues" : ""
  }. A number is how much this run found, not whether it is good or bad.</p>
<div class="grid-wrap"><table class="grid"><thead><tr><td></td>${head}</tr></thead><tbody>${issueHead}${
    issues.join("")
  }${
    issues.length
      ? `<tr class="group"><th scope="rowgroup" colspan="${ds.length + 1}">Every section</th></tr>`
      : ""
  }${sections.join("")}${money.join("")}</tbody></table></div></section>`;
}

/** A bar that stays at the top while reading, to move between candidates in ballot order. */
function jumpHtml(
  r: RaceDossier,
  anchors: readonly string[],
  shared: boolean,
  mine: boolean,
): string {
  if (r.candidates.length < 2) return "";
  const links = [
    `<a href="#glance">Overview</a>`,
    ...r.candidates.map((d, i) => `<a href="#${anchors[i]}">${esc(d.candidate.name)}</a>`),
    shared ? `<a href="#shared">Shared</a>` : "",
    mine ? `<a href="#mine">Your notes</a>` : "",
  ].filter(Boolean);
  return `<nav class="jump" aria-label="On this page">${links.join("")}</nav>`;
}

/** Whether the page's own part holds the voter's pick and notes, not only the ballot walk. */
const hasMine = (mine: string | undefined) => Boolean(mine?.includes(`id="mine"`));

/** The same bar for a measure: its template's main stops, in page order. */
function measureJump(d: MeasureDossier, mine: boolean): string {
  const links = [
    `<a href="#${sectionAnchor("m", "effect")}">What it does</a>`,
    `<a href="#${sectionAnchor("m", "case_for")}">The case for</a>`,
    `<a href="#${sectionAnchor("m", "case_against")}">The case against</a>`,
    d.finance ? `<a href="#${sectionAnchor("m", "filed_support")}">Contributions</a>` : "",
    `<a href="#shared">Shared</a>`,
    mine ? `<a href="#mine">Your notes</a>` : "",
  ].filter(Boolean);
  return `<nav class="jump" aria-label="On this page">${links.join("")}</nav>`;
}

export const STYLES = `
:root {
  /* Surfaces and text. */
  --bg:#fbfaf7; --fg:#1d1d1b; --muted:#5d5b55; --line:#e2dfd7; --line-strong:#c9c4b8; --card:#ffffff; --tint:#f3f1ea;
  --accent:#28536b; --accent-fg:#ffffff;
  /* Notices: info is the page's standing explanations; warn is reserved for something to act on. */
  --info-bg:#edf2f5; --warn-bg:#fff4e0; --warn-fg:#6b4300;
  /* Evidence type: what kind of source backs a fact. Blues, purple, and grey only: red and green mean stance. */
  --ev-opinion:#6b4592;
  /* Stance on a voter's issue. */
  --stance-conflicts:#a3302a; --stance-aligns:#1f6f43;
  /* Job status: done is the normal state, so it stays neutral; a failure is amber, something to act on. */
  --ok:#3f3e3a; --bad:#8a5200;
  /* Shape. */
  --r:10px; --r-lg:12px; --sticky:60px; --name:48px; --dock:64px; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --muted:#a8a69e;
  --line:#34332f; --line-strong:#4a4843; --card:#1f1f1c; --tint:#262622; --accent:#8cc0dc; --accent-fg:#10202a;
  --info-bg:#1d272d; --warn-bg:#3a2c12; --warn-fg:#f3d39b; --ev-opinion:#c9a3e6;
  --stance-conflicts:#f0a090; --stance-aligns:#7fd3a3; --ok:#cfcdc6; --bad:#f3c26b; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 16px 16px 64px; }
h1 { font-size: 1.65rem; line-height: 1.2; margin: 8px 0 4px; }
h2 { font-size: 1.4rem; line-height: 1.25; margin: 0; }
h3 { font-size: 1.1rem; margin: 0 0 2px; }
h4 { font-size: 1.08rem; line-height: 1.3; margin: 22px 0 6px; }
a { color: var(--accent); }
p, li { overflow-wrap: anywhere; }
.sub, .desig, .meta, .searched, .cov { color: var(--muted); }
.meta, .searched { font-size: .85rem; margin: 2px 0 0; }
.banner { background: var(--warn-bg); color: var(--warn-fg); border-radius: var(--r); padding: 12px 14px; margin: 14px 0; }
.banner p { margin: 0; }
.banner details { margin-top: 8px; }
.banner ul { margin: 6px 0 0; padding-left: 20px; }
.note { border-left: 3px solid var(--accent); padding: 4px 12px; margin: 12px 0; }
.cards { list-style: none; padding: 0; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 14px; }
.card a { display: block; padding: 2px 0; }
.card p { margin: 2px 0; font-size: .9rem; }
.cov-fail { color: var(--bad); }
.cov-pending { font-style: italic; }
.inc { font-weight: 600; color: var(--fg); }
.dossier { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 18px 16px; margin: 24px 0; }
.facts { list-style: none; padding: 0; margin: 0; }
.fact { padding: 10px 0; }
.fact + .fact { border-top: 1px solid var(--line); }
.fact p { margin: 4px 0 0; }
/* Evidence chips: told apart by fill and border as well as color. */
.ev { display: inline-block; font-size: .78rem; font-weight: 600; line-height: 1.45; padding: 0 7px; border-radius: 4px; border: 1px solid currentColor; }
.ev-primary_record { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.ev-reported { color: var(--accent); } .ev-opinion { color: var(--ev-opinion); }
.ev-unsourced { color: var(--muted); border-style: dashed; }
.nsrc { font-size: .78rem; color: var(--muted); }
.srcs { list-style: none; padding: 0; margin: 2px 0 0; }
.srcs li { margin: 2px 0; }
.wording { font-size: .9rem; margin-top: 4px; }
.wording summary { color: var(--muted); font-size: .85rem; }
.wording ul { margin: 4px 0 0; padding-left: 20px; }
.wording .src { color: var(--muted); }
.gap { font-style: italic; color: var(--muted); margin: 4px 0; }
.gaps { margin: 0; padding-left: 20px; }
details.unverified { margin-top: 18px; border-top: 1px dashed var(--line); padding-top: 10px; }
details.unverified > summary { font-size: .92rem; }
summary { cursor: pointer; color: var(--muted); padding: 6px 0; }
.back { margin: 16px 0 0; font-size: .95rem; }
footer { color: var(--muted); font-size: .85rem; margin-top: 40px; }
nav.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 4px 0 8px; border-bottom: 1px solid var(--line); }
nav.top a { text-decoration: none; font-weight: 700; padding: 8px 0; }
form.stack { display: grid; gap: 14px; background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 16px; margin: 16px 0; }
label { display: grid; gap: 4px; font-weight: 600; font-size: .95rem; }
label .hint { font-weight: 400; color: var(--muted); font-size: .85rem; }
input, textarea, select { font: inherit; font-size: 16px; width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
textarea { min-height: 96px; }
.row { display: grid; gap: 14px; grid-template-columns: 1fr 1fr; }
@media (max-width: 480px) { .row { grid-template-columns: 1fr; } }
button, .button { font: inherit; font-weight: 700; min-height: 48px; padding: 12px 18px; border-radius: var(--r); border: 0; background: var(--accent); color: var(--accent-fg); cursor: pointer; text-decoration: none; display: inline-block; text-align: center; }
button.secondary, .button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.mine { background: var(--card); border: 2px solid var(--accent); border-radius: var(--r-lg); padding: 16px; margin: 24px 0; display: grid; gap: 12px; scroll-margin-top: 12px; }
.mine h2 { margin: 0; }
.mine p { margin: 0; }
.picks .pick { grid-column: 1 / -1; font-size: 1.05rem; font-weight: 700; margin-top: 2px; }
.picks .undecided { color: var(--muted); font-style: italic; font-weight: 400; }
.picks .notes { white-space: pre-line; margin: 4px 0 0; }
.printonly { display: none; }
button:disabled { opacity: .5; cursor: not-allowed; }
form.inline { display: inline; margin: 0; }
.runs { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.runs a { display: block; background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 14px; text-decoration: none; color: var(--fg); }
.runs .when { color: var(--muted); font-size: .85rem; }
.pill { display: inline-block; font-size: .75rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
.pill-running { color: var(--accent); } .pill-done { color: var(--ok); }
.pill-failed, .pill-interrupted { color: var(--bad); background: var(--warn-bg); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
.error { background: var(--warn-bg); color: var(--warn-fg); border-radius: var(--r); padding: 12px 14px; }
input[type=file] { padding: 10px; }
.names { margin: 0; padding-left: 22px; }
.names .desig { font-size: .85rem; }
fieldset.plain { border: 0; padding: 0; margin: 0; display: grid; gap: 2px; }
fieldset.plain legend { font-weight: 600; font-size: .95rem; padding: 0; margin-bottom: 4px; }
label.check { display: flex; align-items: center; gap: 10px; min-height: 44px; }
label.check input { width: 24px; height: 24px; margin: 0; flex: none; }
.tabs { display: flex; gap: 4px; margin: 12px 0; padding: 4px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--card); }
.tabs a { flex: 1; text-align: center; padding: 10px 4px; border-radius: 9px; text-decoration: none; font-weight: 600; font-size: .92rem; min-height: 44px; }
.tabs a[aria-current=page] { background: var(--accent); color: var(--accent-fg); }
.tabs .count { font-weight: 400; opacity: .85; }
.items, .picks { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.item, .picks > li { background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 0 14px; scroll-margin-top: 12px; }
.item > details > summary, .picks summary { color: var(--fg); padding: 12px 0; display: grid; grid-template-columns: 1fr auto; column-gap: 8px; list-style: none; }
.item > details > summary::-webkit-details-marker, .picks summary::-webkit-details-marker { display: none; }
.item > details > summary::after, .picks summary::after { content: "Show"; grid-column: 2; grid-row: 1; color: var(--accent); font-size: .85rem; font-weight: 600; }
.item > details[open] > summary::after, .picks details[open] summary::after { content: "Hide"; }
.item-title { font-weight: 700; grid-column: 1; }
.item-meta, .item-lean { grid-column: 1 / -1; color: var(--muted); font-size: .88rem; }
.item-lean strong { color: var(--fg); }
.item-body { display: grid; gap: 12px; padding: 0 0 12px; }
.item-body details { display: grid; gap: 10px; }
.item-body details label { margin-top: 10px; }
.item label.research { border-top: 1px solid var(--line); }
.item-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding-top: 12px; }
.item > p { margin: 2px 0; }
.item .actions { margin: 10px 0 12px; flex-wrap: nowrap; }
.item .actions .button { flex: 1; min-height: 44px; padding: 10px 8px; font-size: .92rem; }
.who { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 6px; }
.who li { border-top: 1px solid var(--line); padding-top: 6px; }
.who .desig { font-size: .85rem; }
.who .stance, .who .cov { font-size: .85rem; margin: 2px 0; }
form.ballot { background: transparent; border: 0; padding: 0; }
form.ballot h2 { margin-top: 8px; }
details.settings { background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 0 14px; }
details.settings[open] { padding-bottom: 14px; }
details.settings > summary { color: var(--fg); font-weight: 600; padding: 12px 0; }
details.settings > summary .item-meta { display: block; font-weight: 400; padding-left: 1.1em; }
details.settings[open] > div.row { margin-bottom: 14px; }
details.banner > summary { color: var(--warn-fg); padding: 0; }
details.banner > p { margin-top: 8px; }
.item-lean a { display: inline-block; min-height: 44px; padding: 10px 0; text-decoration: none; color: var(--muted); }
.item .will { display: none; grid-column: 1 / -1; color: var(--accent); font-weight: 600; font-size: .88rem; }
.item:has(> label.research input:checked) { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.item:has(> label.research input:checked) .will { display: block; }
.item:has(> label.research input:checked) .will::before { content: "✓ "; }
/* A live count of what's checked, with no script: counters run in document order, and the bar comes last. */
form.ballot { counter-reset: checked; }
/* "Hide the N with a saved pick": no script. One checked to research stays, so nothing hidden is researched unseen. */
form.ballot:has(.hide-decided input:checked) .item.decided:not(:has(> label.research input:checked)) { display: none; }
label.research input:checked { counter-increment: checked; }
form.ballot:has(label.research input:checked) .bar button.go::after { content: " (" counter(checked) ")"; }
.who a.who-name { display: block; min-height: 44px; padding: 10px 0; text-decoration: none; font-weight: 600; }
.who a.who-name .desig { font-weight: 400; }
.item-lean .link { color: var(--accent); text-decoration: underline; }
.picks .pick .label { color: var(--muted); font-weight: 400; font-size: .9rem; }
.mine form.stack { border: 0; padding: 0; margin: 0; background: transparent; }
details.note > summary { padding: 0; }
.bar { position: sticky; bottom: 0; z-index: 1; background: var(--bg); border-top: 1px solid var(--line); padding: 10px 0 12px; margin-top: 4px; display: grid; gap: 6px; }
.bar-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.bar-buttons button { flex: 1 1 120px; min-height: 44px; padding: 8px 10px; white-space: nowrap; font-size: .95rem; }
fieldset.plain > .hint { color: var(--muted); font-size: .85rem; margin: -4px 0 4px; }
.bar .sub { margin: 0; font-size: .82rem; }
.walk { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; margin: 12px 0; border: 1px solid var(--line); border-radius: var(--r); background: var(--card); }
.walk a { display: flex; align-items: center; gap: 4px; min-height: 44px; padding: 6px 10px; text-decoration: none; font-weight: 600; font-size: .9rem; min-width: 0; }
.walk span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.walk .next { justify-content: flex-end; }
.walk .mid { color: var(--muted); font-weight: 400; }
.priorities { background: var(--tint); border-radius: var(--r); padding: 2px 14px 12px; margin-top: 16px; }
.priorities > h4 { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 12px 0 0; }
.priorities .sec { border-top-color: var(--line-strong); }
h5 { font-size: 1rem; margin: 16px 0 4px; }
.st { margin: 4px 0 0; }
details.ctx { display: inline-block; }
details.ctx[open] { display: inline; }
details.ctx > summary, .ctx-eg { display: inline-block; list-style: none; font-size: .78rem; font-weight: 700; line-height: 1.5; color: var(--accent); border: 1px solid currentColor; border-radius: 999px; padding: 1px 9px; margin: 0 2px 0 4px; vertical-align: 1px; }
/* The pill stays small in the sentence; its tap area reaches past it. */
details.ctx > summary { min-width: 36px; text-align: center; position: relative; }
details.ctx > summary::after { content: ""; position: absolute; inset: -10px -6px; }
details.ctx > summary::-webkit-details-marker { display: none; }
details.ctx[open] > summary { background: var(--accent); color: var(--accent-fg); }
.ctx-body { display: block; font-size: .9rem; border-left: 3px solid var(--accent); padding: 4px 10px; margin: 6px 0; }
.ctx-body .meta { display: block; }
.stance { margin: 4px 0; padding: 4px 10px; border-left: 4px solid currentColor; font-size: .95rem; }
.card .stance { font-size: .85rem; }
.stance .basis { color: var(--fg); }
.stance-conflicts { color: var(--stance-conflicts); } .stance-aligns { color: var(--stance-aligns); }
/* Mixed is both ways: body text, with a rule half conflicts and half aligns. */
.stance-mixed { color: var(--fg); }
.stance.stance-mixed { border-left: 4px solid; border-image: linear-gradient(var(--stance-conflicts) 50%, var(--stance-aligns) 50%) 1; } .stance-unclear { color: var(--muted); }
.measure-q { white-space: pre-line; }
.votes { display: grid; gap: 10px; margin: 10px 0 6px; }
@media (min-width: 640px) { .votes { grid-template-columns: 1fr 1fr; } }
.vote { background: var(--tint); border-left: 4px solid var(--accent); border-radius: var(--r); padding: 10px 14px; min-width: 0; overflow-wrap: anywhere; }
.vote p { margin: 0; }
.vote .vote-label { font-weight: 700; letter-spacing: .04em; margin-bottom: 2px; }
.vote .meta { margin-top: 6px; }
.money .sub { font-size: .85rem; margin: 0 0 4px; }
.totals { list-style: none; padding: 0; margin: 4px 0 8px; }
.totals li { margin: 2px 0; }
details.shared { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 0 16px; margin: 24px 0; }
details.shared > summary { color: var(--fg); font-weight: 700; padding: 12px 0; }
details.shared[open] { padding-bottom: 12px; }
.pair { border-top: 1px solid var(--line); }
.pair > summary { color: var(--fg); min-height: 44px; }
.pair > summary h5 { display: inline; margin: 0; }
.pair > summary .desig { font-size: .85rem; font-weight: 400; }
.pair[open] { padding-bottom: 8px; }
details.fold-race { margin-bottom: 20px; }
details.fold-race > summary { color: var(--fg); padding: 14px 0 6px; }
details.fold-race > summary h2 { display: inline; }
/* A long list in a section, folded the same way for everyone; its heading and notes stay in view. */
details.fold { margin: 8px 0; }
details.fold > summary { color: var(--accent); font-weight: 600; font-size: .95rem; min-height: 44px; }
.shared-list { list-style: none; padding: 0; margin: 0; }
.shared-list > li { padding: 6px 0; }
.ties { margin: 4px 0 0; padding-left: 18px; font-size: .9rem; }
.ties li { margin: 4px 0; }
.who-tag { font-weight: 600; }
.ballot-lines, .runs-from { margin: 0; padding-left: 20px; }
.ballot-lines li, .runs-from li { margin: 6px 0; }
.from { font-style: italic; }
/* Links: an entity (a page about a name) is dotted, a citation is quiet, navigation is the accent. */
a.ent { color: inherit; text-decoration: underline dotted; text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
.meta a, .searched a { color: var(--muted); text-underline-offset: 2px; padding: 6px 0; }
.sec { scroll-margin-top: var(--sticky); }
.dossier .sec { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 2px; }
.dossier:has(.dossier-name) .sec { scroll-margin-top: calc(var(--sticky) + var(--name)); }
.dossier .sec > h4, .dossier .sec > h5 { margin-top: 12px; }
/* A measure's dossier has no header, so its first section needs no rule above it. */
.dossier > section:first-child { border-top: 0; margin-top: 0; }
/* Whose dossier this is stays in view while reading it, under the jump bar; the next one takes its place. */
.dossier-name { position: sticky; top: 0; z-index: 1; background: var(--card); margin: -10px -16px 0; padding: 10px 16px 8px; font-size: 1.3rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--line); }
/* Slid a little under the jump bar, so no line of text shows between the two. */
nav.jump ~ .dossier .dossier-name { top: calc(var(--sticky) - 8px); }
.dossier-desig { margin: 6px 0 0; }
.dossier, #glance, #shared, #mine { scroll-margin-top: var(--sticky); }
/* A section with nothing found keeps its place and says so, on one compact line. */
.sec.empty { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; }
.dossier .sec.empty { margin-top: 6px; padding-top: 0; }
.sec.empty > h4 { font-size: .95rem; font-weight: 600; color: var(--muted); margin: 8px 0 2px; }
.sec.empty > .gap { font-size: .88rem; margin: 0; }
.sec.empty > .searched, .sec.empty > .sub, .sec.empty > ul { flex-basis: 100%; }
.searched { font-size: .8rem; }
.fact.ref .jumpto { color: var(--accent); font-weight: 600; }
.banner.info { background: var(--info-bg); color: var(--fg); }
.banner.info summary { color: var(--muted); }
.legend { display: grid; grid-template-columns: max-content 1fr; gap: 6px 10px; align-items: baseline; margin: 8px 0; }
.legend dt, .legend dd { margin: 0; }
.note details summary { padding: 4px 0 0; font-size: .9rem; }
.note > p { margin: 0; }
/* At a glance: candidates across, the template down. Scrolls inside its box, never the page. */
.glance { margin: 28px 0 8px; }
.glance .sub { margin: 4px 0 10px; font-size: .9rem; }
.grid-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r); background: var(--card); }
table.grid { border-collapse: collapse; width: 100%; font-size: .88rem; line-height: 1.3; }
.grid th, .grid td { padding: 0 6px; border-top: 1px solid var(--line); text-align: center; vertical-align: middle; }
.grid thead th, .grid thead td { border-top: 0; padding: 10px 4px 8px; vertical-align: bottom; font-size: .82rem; min-width: 64px; overflow-wrap: break-word; }
.grid thead a { text-decoration: none; font-weight: 700; }
.grid tbody th { text-align: left; font-weight: 500; font-size: .84rem; position: sticky; left: 0; background: var(--card); width: 30%; min-width: 104px; padding: 6px 6px 6px 10px; }
.grid td a { display: block; min-height: 36px; line-height: 36px; font-weight: 700; text-decoration: none; font-variant-numeric: tabular-nums; }
.grid td.none { color: var(--muted); font-size: .82rem; }
.grid tr.group th { background: var(--tint); text-transform: uppercase; font-size: .72rem; letter-spacing: .05em; color: var(--muted); font-weight: 600; padding: 6px 10px; }
.inc-mark { display: block; font-weight: 400; font-size: .75rem; color: var(--muted); }
.inc-mark.cov-fail { color: var(--bad); font-weight: 600; }
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* The jump bar stays at the top while reading the dossiers. */
nav.jump { position: sticky; top: 0; z-index: 2; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 16px -16px 0; padding: 8px 16px; background: var(--bg); border-bottom: 1px solid var(--line); }
nav.jump a { flex: none; display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); text-decoration: none; font-weight: 600; font-size: .88rem; white-space: nowrap; }
/* Your pick, at the bottom of the screen while reading: it rests just above the pick card. */
.dock { position: sticky; bottom: 0; z-index: 2; display: grid; grid-template-columns: auto 1fr auto; gap: 4px; align-items: center; margin: 24px -16px 0; padding: 8px 16px calc(8px + env(safe-area-inset-bottom)); background: var(--bg); border-top: 1px solid var(--line); }
.dock a { display: flex; align-items: center; min-height: 44px; min-width: 44px; justify-content: center; text-decoration: none; font-weight: 600; }
.dock .dock-pick { justify-content: flex-start; gap: 6px; min-width: 0; padding: 0 12px; border: 1px solid var(--accent); border-radius: var(--r); background: var(--card); }
.dock .dock-pick span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dock .dock-pick .label { flex: none; color: var(--muted); font-weight: 400; font-size: .88rem; }
.dock .dock-pick .undecided { color: var(--muted); font-style: italic; font-weight: 400; }
.dock + .mine { margin-top: 12px; }
/* Back to the top: a plain link, so it works in downloads too. Fades in after a screen of scrolling where the browser can tell. */
.to-top { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 3; width: 48px; height: 48px; display: grid; place-items: center; border-radius: 999px; border: 1px solid var(--accent); background: var(--card); color: var(--accent); font-size: 1.3rem; font-weight: 700; text-decoration: none; box-shadow: 0 2px 8px rgb(0 0 0 / .18); }
body:has(.dock) .to-top { bottom: calc(var(--dock) + 12px + env(safe-area-inset-bottom)); }
body:has(form.ballot .bar) .to-top { bottom: calc(112px + env(safe-area-inset-bottom)); }
@supports (animation-timeline: scroll()) {
  .to-top { opacity: 0; visibility: hidden; animation: to-top-in linear both; animation-timeline: scroll(root block); animation-range: 0 900px; }
  @keyframes to-top-in { 0%, 85% { opacity: 0; visibility: hidden; } 100% { opacity: 1; visibility: visible; } }
}
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
/* Contributions: one table per filing, amounts lined up. */
.gift-group { margin: 12px 0; }
.gift-group > .meta { margin: 0 0 2px; }
table.gifts { width: 100%; border-collapse: collapse; font-size: .92rem; font-variant-numeric: tabular-nums; }
.gifts th, .gifts td { text-align: left; vertical-align: top; padding: 8px 8px 8px 0; border-top: 1px solid var(--line); }
.gifts thead th { border-top: 0; padding-bottom: 4px; font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.gifts tbody th { font-weight: 600; }
.gifts .desig { display: block; font-weight: 400; font-size: .85rem; }
.gifts .num { text-align: right; white-space: nowrap; }
.gifts .date { white-space: nowrap; color: var(--muted); padding-right: 0; }
/* Last, so it wins over the screen rules above. */
@media print { nav.top, nav.jump, .dock, .to-top, .actions, .noprint, .tabs, .walk, .bar, .picks summary::after { display: none; } .picks > li { padding: 4px 14px; } .printonly { display: block; } body { font-size: 12pt; } .picks li { break-inside: avoid; } details.fold::details-content, details.pair::details-content { content-visibility: visible; display: contents; } }
`;

export interface PageOptions {
  /** Reload the page every N seconds (used while research is running). No script needed. */
  refreshSeconds?: number;
  /** Show the app's top bar with a link home. Off for exported static files. */
  nav?: boolean;
  /** Mount prefix (e.g. "/ballotfix") for the nav's home links. Empty when served at root. */
  base?: string;
  /** The top bar's right-hand link, already prefixed. Default: "New race". */
  back?: { href: string; label: string };
}

/**
 * The app icon: a ballot of unmarked ovals under a magnifying lens (research, never a
 * pick). Kept identical to static/icon.svg, which is the copy for use outside the page.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <g id="sheet">
      <rect x="11" y="9" width="32" height="42" rx="4" fill="#fbfaf7" />
      <g fill="none" stroke="#28536b" stroke-width="2.2" stroke-linecap="round">
        <ellipse cx="18.5" cy="19" rx="2.8" ry="2" />
        <ellipse cx="18.5" cy="29" rx="2.8" ry="2" />
        <ellipse cx="18.5" cy="39" rx="2.8" ry="2" />
        <path d="M25 19h12M25 29h12M25 39h12" />
      </g>
    </g>
    <clipPath id="lens"><circle cx="35" cy="40" r="8" /></clipPath>
  </defs>
  <rect width="64" height="64" rx="14" fill="#28536b" />
  <use href="#sheet" />
  <g clip-path="url(#lens)">
    <rect width="64" height="64" fill="#1f4357" />
    <use href="#sheet" transform="translate(35 40) scale(1.6) translate(-35 -40)" />
  </g>
  <circle cx="35" cy="40" r="10" fill="none" stroke="#f3d39b" stroke-width="4" />
  <path d="M42.5 47.5l8.5 8.5" stroke="#f3d39b" stroke-width="6" stroke-linecap="round" />
</svg>`;

/** Embedded as data: so exported pages stay self-contained. */
const ICON_HREF = `data:image/svg+xml;base64,${btoa(ICON_SVG)}`;

/** The page's Content-Security-Policy; the server sends the same one as a header. */
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'";

/** Where the app serves static/apple-touch-icon.png (under its base path). */
export const TOUCH_ICON_PATH = "/apple-touch-icon.png";

/** Full HTML document with a strict CSP: no scripts, no external resources. */
export function page(title: string, body: string, opts: PageOptions = {}): string {
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${Math.max(2, Math.floor(opts.refreshSeconds))}">`
    : "";
  const base = opts.base ?? "";
  const back = opts.back ?? { href: `${base}/?new#new`, label: "New race" };
  const nav = opts.nav
    ? `<nav class="top"><a href="${base}/">Ballot Fix</a><a href="${esc(back.href)}">${
      esc(back.label)
    }</a></nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<link rel="icon" type="image/svg+xml" href="${ICON_HREF}">
${opts.nav ? `<link rel="apple-touch-icon" href="${base}${TOUCH_ICON_PATH}">` : ""}
${refresh}
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main id="top">
${nav}
${body}
</main>
<a class="to-top" href="#top" aria-label="Back to top"><span aria-hidden="true">↑</span></a>
</body>
</html>
`;
}

/** "2026-11-03" -> "Nov 3, 2026". Falls back to the input if it isn't a date. */
export function readableDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  // An impossible day ("2024-02-30") would roll over to another date: keep it as given.
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso
    ? iso
    : d.toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
}

export function titleFor(q: { city: string; office: string; electionDate: string }): string {
  return `${q.city} ${q.office} · ${readableDate(q.electionDate)}`;
}

export function raceTitle(r: RaceDossier): string {
  return titleFor(r.query);
}

/** The race overview and every dossier: shared by the app and the static export. */
export function raceBody(
  r: RaceDossier,
  extra: { status?: string; actions?: string; mine?: string; links?: EntityLinks } = {},
): string {
  const q = r.query;
  const inc = incumbencyNote(r.listing);
  const source = r.listing.source_url
    ? link(r.listing.source_url, r.listing.source_name)
    : esc(r.listing.source_name);
  const empty = r.candidates.length === 0
    ? `<p class="gap">No candidates were found for this race. ${
      r.listing.notes ? esc(r.listing.notes) : ""
    }</p>`
    : "";
  const model = r.candidates.find((c) => c.model)?.model;
  const links = extra.links;
  const notes = notesFor(r.context, q.state, q.city, links);
  const anchors = candidateAnchors(r.candidates.map((d) => d.candidate.name));
  const glance = glanceHtml(r, anchors);
  const showShared = r.candidates.length > 0 && !r.candidates.some((c) => c.status === "pending");

  return `<h1>${esc(raceTitle(r))}</h1>
<p class="sub">${esc(q.city)}, ${esc(q.state)} · Candidate list from ${source} · Researched ${
    esc(readableDate(r.generated_at.slice(0, 10)))
  }</p>
${extra.status ?? ""}
${extra.actions ?? ""}

<div class="banner info"><p><strong>This page does not rank, score, or recommend anyone.</strong> Every candidate gets the same sections and the same research instructions.</p>
${cantSee(r.standing_gaps)}
${readingGuide("candidates' own statements")}</div>

${askedAbout(r.priorities, "Every candidate was asked about the same issues, in the same words.")}
<h2${glance ? "" : ` id="glance"`}>${
    r.listing.contest_kind === "retention" ? "On the ballot" : "Candidates"
  }</h2>
<p class="sub">${ORDER_LABEL[r.listing.order_basis]}${
    r.listing.notes ? ` ${esc(r.listing.notes)}` : ""
  }</p>
${inc ? `<p class="note">${esc(inc)}</p>` : ""}
${empty}
<ul class="cards">${r.candidates.map((d, i) => overviewCard(d, anchors[i])).join("")}</ul>
${glance}
${jumpHtml(r, anchors, showShared, hasMine(extra.mine))}

${
    r.candidates.map((d, i) =>
      dossierSection(
        d,
        anchors[i],
        notes,
        r.candidates[i + 1] && { d: r.candidates[i + 1], anchor: anchors[i + 1] },
        r.finance,
        r.finance?.subjects.find((s) => s.candidate === i),
        links && d.status !== "pending"
          ? {
            ref: personRef(
              q.state,
              q.city,
              d.candidate.name,
              d.identity_note ? links.runId : undefined,
            ),
            links,
          }
          : undefined,
      )
    ).join("")
  }
${portalGapsHtml(r.finance)}
${
    !showShared ? "" : sharedHtml(
      raceConnections(r, links?.runId),
      r.finance,
      r.context,
      `${q.city}, ${q.state}`,
      "Only one name is on the ballot here, so there is nothing to compare.",
      links,
    )
  }
${namesHtml(r.context)}

${extra.mine ?? ""}
<footer>
<p>Generated by Ballot Fix using AI-assisted web research${
    model ? ` (${esc(model)})` : ""
  }. It can be wrong. Check anything that matters to your vote at the linked source.</p>
</footer>`;
}

function askedAbout(issues: readonly string[] | undefined, same: string): string {
  if (!issues?.length) return "";
  return `<div class="note"><p><strong>You asked about:</strong> ${
    issues.map(esc).join("; ")
  }. ${same}</p><details><summary>How your issues are marked</summary><p>Findings on them come first. Where your wording states a view, each issue is marked as conflicting with it, matching it, or mixed, but only when a verified source backs that up. That is a reading of the cited record, not a recommendation, and there is no overall score: open the sources before relying on it.</p></details></div>`;
}

/** The standing coverage gaps: always on the page, collapsed under a count. */
function cantSee(gaps: readonly string[]): string {
  return `<details><summary>What this research can't see (${gaps.length})</summary>
<ul>${gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></details>`;
}

/** What the evidence tags and source counts mean, kept out of the way until asked for. */
export function readingGuide(ownStatements: string): string {
  return `<details><summary>How to read this page</summary>
<dl class="legend">
<dt>${evTag("primary_record")}</dt><dd>A government or official document.</dd>
<dt>${evTag("reported")}</dt><dd>Journalism describing events.</dd>
<dt>${evTag("opinion")}</dt><dd>Endorsements, editorials, and ${esc(ownStatements)}.</dd>
<dt>${evTag("unsourced")}</dt><dd>Asserted without support.</dd>
</dl>
<p>A fact marked "reported by N sources" was stated by that many different outlets; it is shown once, with each of them. More sources means wider reporting, not that it is truer or more important.</p>
<p>In the app, a name with a dotted underline opens everything the research holds on it. A <span class="ctx-eg">who?</span> or <span class="ctx-eg">what?</span> after a name opens a one-line note on it.</p>
</details>`;
}

/** Standalone page for a finished race (CLI output and downloads). */
export function renderRace(r: RaceDossier): string {
  return page(raceTitle(r), raceBody(r));
}

export function measureTitle(m: { label: string; jurisdiction: string; electionDate: string }) {
  return [m.label, m.jurisdiction, readableDate(m.electionDate)].filter(Boolean).join(" · ");
}

/** One measure's page: the same template for every measure, both sides sought equally. */
export function measureBody(
  d: MeasureDossier,
  extra: {
    status?: string;
    actions?: string;
    mine?: string;
    stopped?: boolean;
    links?: EntityLinks;
  } = {},
): string {
  const q = d.query;
  const question = q.question
    ? `<p class="note measure-q"><strong>Ballot question as read from your ballot.</strong> ${
      esc(q.question)
    }</p>`
    : "";
  const official = d.official_title
    ? `<p class="sub">Official title: ${esc(d.official_title)}</p>`
    : "";
  const identity = d.identity_note
    ? `<p class="note"><strong>Identity check.</strong> ${esc(d.identity_note)}</p>`
    : "";
  const links = extra.links;
  const notes = notesFor(d.context, q.state, q.jurisdiction, links);
  const shown = shownInPriorities(d.priorities, "m");
  const failed = failedNote(d.status === "failed", d.sections);
  const body = d.status === "pending"
    ? `<p class="gap">${
      extra.stopped
        ? "Research on this measure stopped before it finished. Research it again to fill this in."
        : "Research on this measure is still running. This page updates on its own."
    }</p>`
    : `${failed.note}${prioritiesHtml(d.priorities, "measure", notes, "m", failed.section)}
${
      MEASURE_SECTIONS.map((s) =>
        sectionHtml(s.title, failed.section(d.sections[s.id]), notes, {
          id: sectionAnchor("m", s.id),
          shown,
          between: s.id === "effect" && d.status === "ok" ? voteMeansHtml(d.vote_means, notes) : "",
        })
      ).join("")
    }
${
      (["support", "oppose"] as const).map((side) =>
        moneyHtml(
          d.finance,
          d.finance?.subjects.find((s) => s.side === side),
          `Contributions on file: ${SIDE_LABEL[side].toLowerCase()}`,
          `Contributions on file: ${
            entityName(SIDE_LABEL[side].toLowerCase(), sideRef(q, side), links)
          }`,
          sectionAnchor("m", `filed_${side}`),
        )
      ).join("")
    }
${gapsAndUnverified(d.gaps, d.unverified, notes)}
${portalGapsHtml(d.finance)}
${
      sharedHtml(
        measureConnections(d, links?.runId),
        d.finance,
        d.context,
        [q.jurisdiction, q.state].filter(Boolean).join(", "),
        "",
        links,
      )
    }
${namesHtml(d.context)}`;

  return `<h1>${esc(measureTitle(q))}</h1>
<p class="sub">${esc(q.jurisdiction || "Jurisdiction not read")}, ${esc(q.state)} · Researched ${
    esc(readableDate(d.generated_at.slice(0, 10)))
  }</p>
${official}
${extra.status ?? ""}
${extra.actions ?? ""}

<div class="banner info"><p><strong>This page does not recommend a yes or no vote.</strong> Every measure gets the same sections, and the case for and the case against are researched with the same instructions.</p>
${cantSee(d.standing_gaps)}
${readingGuide("ballot arguments, and campaigns' own statements")}</div>
${
    askedAbout(
      d.priority_issues,
      "Supporters' and opponents' claims about them were sought equally.",
    )
  }
${d.status === "ok" ? stanceSummary(d.priorities, "measure") : ""}
${question}
${identity}
${d.status === "pending" ? "" : measureJump(d, hasMine(extra.mine))}
<article class="dossier">
${body}
</article>

${extra.mine ?? ""}
<footer>
<p>Generated by Ballot Fix using AI-assisted web research${
    d.model ? ` (${esc(d.model)})` : ""
  }. It can be wrong. Check anything that matters to your vote at the linked source.</p>
</footer>`;
}

export function renderMeasure(d: MeasureDossier): string {
  return page(measureTitle(d.query), measureBody(d));
}
