/**
 * Renders a RaceDossier as one self-contained HTML page.
 *
 * Every string that came from research is untrusted: it is HTML-escaped, and
 * only http(s) URLs ever become links. The page has no scripts at all.
 */

import { attachNotes, MAX_CONTEXT_NAMES } from "./context.ts";
import { coveredSections, incumbencyNote } from "./dossier.ts";
import { MEASURE_SECTIONS, SECTIONS } from "./template.ts";
import type {
  CandidateDossier,
  ContextNote,
  ContextResult,
  EvidenceType,
  Fact,
  MeasureDossier,
  OrderBasis,
  PriorityResult,
  RaceDossier,
  SectionResult,
  Stance,
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

function link(url: string | null, text: string): string {
  const href = safeHref(url);
  return href
    ? `<a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">${esc(text)}</a>`
    : esc(text);
}

export function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

const EVIDENCE_LABEL: Record<EvidenceType, string> = {
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

function factMeta(f: Fact): string {
  return [
    link(f.source_url, f.source_name),
    f.author ? `by ${esc(f.author)}` : "author not stated",
    f.published ? esc(f.published) : "date not stated",
  ].join(" · ");
}

/** Context notes the page shows next to names; [] for runs without them. */
type Notes = readonly ContextNote[];

function noteMeta(n: ContextNote): string {
  return [
    link(n.source_url, n.source_name),
    n.author ? `by ${esc(n.author)}` : "",
    n.published ? esc(n.published) : "date not stated",
  ].filter(Boolean).join(" · ");
}

/**
 * A fact's statement, with a collapsed note after each name that has one
 * (src/context.ts). Without notes it is the plain paragraph it always was;
 * with them it is a div, since a <details> can't sit inside a <p>.
 */
function statementHtml(statement: string, notes: Notes): string {
  const pieces = attachNotes(statement, notes);
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
          esc(p.text + stuck(i))
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

/**
 * One fact. A merged one (src/merge.ts) shows once, with every outlet that
 * reported it and, collapsed, how each of the others worded it.
 */
function factItem(f: Fact, notes: Notes = []): string {
  const also = f.also ?? [];
  const tag = `<span class="ev ev-${f.evidence_type}">${EVIDENCE_LABEL[f.evidence_type]}</span>`;
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

/** How much of the template a finished candidate's research found sources for. */
export function coverageLine(d: CandidateDossier): string {
  return `<p class="cov">Sourced facts found in ${
    coveredSections(d)
  } of ${SECTIONS.length} sections.</p>`;
}

function overviewCard(d: CandidateDossier): string {
  const c = d.candidate;
  const status = d.status === "failed"
    ? `<p class="cov cov-fail">Research failed in this run. Nothing about this candidate was checked.</p>`
    : d.status === "pending"
    ? `<p class="cov cov-pending">Researching now…</p>`
    : coverageLine(d);
  return `<li class="card">
  <h3><a href="#${slug(c.name)}">${esc(c.name)}</a></h3>
  <p class="desig">${
    c.ballot_designation ? esc(c.ballot_designation) : "Ballot designation not found"
  }${c.incumbent ? ` · <span class="inc">Incumbent</span>` : ""}</p>
  ${d.status === "ok" ? stanceSummary(d.priorities, "candidate") : ""}
  ${status}
</li>`;
}

/** Runs saved before a section was added to the template don't have it. */
const NOT_IN_THIS_RUN: SectionResult = {
  facts: [],
  searched: [],
  gap_note: "This section was added after this run; research again to fill it.",
};

/** A section's facts, gap note, and what was searched. `between` goes right under the heading. */
function sectionHtml(
  title: string,
  r: SectionResult | undefined,
  notes: Notes,
  tag = "h4",
  between = "",
): string {
  r ??= NOT_IN_THIS_RUN;
  const facts = r.facts.length
    ? `<ul class="facts">${r.facts.map((f) => factItem(f, notes)).join("")}</ul>`
    : "";
  const gap = r.gap_note ? `<p class="gap">${esc(r.gap_note)}</p>` : "";
  const searched = r.searched.length
    ? `<p class="searched">Looked at: ${r.searched.map(esc).join("; ")}</p>`
    : "";
  return `<section class="sec"><${tag}>${
    esc(title)
  }</${tag}>${between}${facts}${gap}${searched}</section>`;
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
): string {
  if (!p?.length) return "";
  return `<section class="priorities"><h4>On what you said matters to you</h4>${
    p.map((x) => sectionHtml(x.issue, x.result, notes, "h5", stanceBadge(x, subject))).join("")
  }</section>`;
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
      ? `<p class="gap">Notes on these names couldn't be written in this run (${esc(c.error)}).</p>`
      : `<p>Names were picked out of the facts automatically, so some may be missed.${
        shown.length
          ? ` A <span class="ctx-eg">who?</span> or <span class="ctx-eg">what?</span> after a name opens a one-line note on who or what it is, from a page this run retrieved. Notes describe; they don't evaluate.`
          : ""
      } Every name was looked up the same way, whichever candidate or side it came up for.</p>`,
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

function dossierSection(d: CandidateDossier, notes: Notes, next?: CandidateDossier): string {
  const c = d.candidate;
  if (d.status === "pending") {
    return `<article class="dossier pending" id="${slug(c.name)}">
  <h2>${esc(c.name)}</h2>
  <p class="gap">Research on this candidate is still running. This page updates on its own.</p>
</article>`;
  }
  const sections = SECTIONS.map((s) => sectionHtml(s.title, d.sections[s.id], notes)).join("");

  const identity = d.identity_note
    ? `<p class="note"><strong>Identity check.</strong> ${esc(d.identity_note)}</p>`
    : "";

  return `<article class="dossier" id="${slug(c.name)}">
  <h2>${esc(c.name)}</h2>
  <p class="desig">${
    c.ballot_designation ? esc(c.ballot_designation) : "Ballot designation not found"
  }${c.incumbent ? ` · <span class="inc">Incumbent</span>` : ""}</p>
  ${identity}
  ${prioritiesHtml(d.priorities, "candidate", notes)}
  ${sections}
  ${gapsAndUnverified(d.gaps, d.unverified, notes)}
  <p class="back"><a href="#top">Back to all candidates</a>${
    next ? ` · <a href="#${slug(next.candidate.name)}">Next: ${esc(next.candidate.name)}</a>` : ""
  }</p>
</article>`;
}

export const STYLES = `
:root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#5d5b55; --line:#e2dfd7; --card:#ffffff;
  --accent:#28536b; --accent-fg:#ffffff; --warn-bg:#fff4e0; --warn-fg:#6b4300;
  --ev-primary:#1f6f43; --ev-reported:#28536b; --ev-opinion:#7a4d9c; --ev-unsourced:#8a3b2e; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --muted:#a8a69e;
  --line:#34332f; --card:#1f1f1c; --accent:#8cc0dc; --accent-fg:#10202a; --warn-bg:#3a2c12; --warn-fg:#f3d39b;
  --ev-primary:#7fd3a3; --ev-reported:#8cc0dc; --ev-opinion:#c9a3e6; --ev-unsourced:#f0a090; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 16px 16px 64px; }
h1 { font-size: 1.55rem; line-height: 1.25; margin: 8px 0 4px; }
h2 { font-size: 1.3rem; margin: 0; }
h3 { font-size: 1.05rem; margin: 0 0 2px; }
h4 { font-size: 0.9rem; margin: 22px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
a { color: var(--accent); }
p, li { overflow-wrap: anywhere; }
.sub, .desig, .meta, .searched, .cov { color: var(--muted); }
.meta, .searched { font-size: .85rem; margin: 2px 0 0; }
.banner { background: var(--warn-bg); color: var(--warn-fg); border-radius: 10px; padding: 12px 14px; margin: 14px 0; }
.banner p { margin: 0; }
.banner details { margin-top: 8px; }
.banner ul { margin: 6px 0 0; padding-left: 20px; }
.note { border-left: 3px solid var(--accent); padding: 4px 12px; margin: 12px 0; }
.cards { list-style: none; padding: 0; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card a { display: block; padding: 2px 0; }
.card p { margin: 2px 0; font-size: .9rem; }
.cov-fail { color: var(--ev-unsourced); }
.cov-pending { font-style: italic; }
.inc { font-weight: 600; color: var(--fg); }
.dossier { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px 16px; margin: 24px 0; scroll-margin-top: 12px; }
.facts { list-style: none; padding: 0; margin: 0; }
.fact { border-top: 1px solid var(--line); padding: 10px 0; }
.fact p { margin: 4px 0 0; }
.ev { display: inline-block; font-size: .72rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
.ev-primary_record { color: var(--ev-primary); } .ev-reported { color: var(--ev-reported); }
.ev-opinion { color: var(--ev-opinion); } .ev-unsourced { color: var(--ev-unsourced); }
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
summary { cursor: pointer; color: var(--muted); padding: 6px 0; }
.back { margin: 16px 0 0; font-size: .95rem; }
footer { color: var(--muted); font-size: .85rem; margin-top: 40px; }
nav.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 4px 0 8px; border-bottom: 1px solid var(--line); }
nav.top a { text-decoration: none; font-weight: 700; padding: 8px 0; }
form.stack { display: grid; gap: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 16px 0; }
label { display: grid; gap: 4px; font-weight: 600; font-size: .95rem; }
label .hint { font-weight: 400; color: var(--muted); font-size: .85rem; }
input, textarea { font: inherit; font-size: 16px; width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
textarea { min-height: 96px; }
.row { display: grid; gap: 14px; grid-template-columns: 1fr 1fr; }
@media (max-width: 480px) { .row { grid-template-columns: 1fr; } }
button, .button { font: inherit; font-weight: 700; min-height: 48px; padding: 12px 18px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-fg); cursor: pointer; text-decoration: none; display: inline-block; text-align: center; }
button.secondary, .button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.mine { background: var(--card); border: 2px solid var(--accent); border-radius: 12px; padding: 16px; margin: 24px 0; display: grid; gap: 12px; scroll-margin-top: 12px; }
.mine h2 { margin: 0; }
.mine p { margin: 0; }
.picks .pick { grid-column: 1 / -1; font-size: 1.05rem; font-weight: 700; margin-top: 2px; }
.picks .undecided { color: var(--muted); font-style: italic; font-weight: 400; }
.picks .notes { white-space: pre-line; margin: 4px 0 0; }
.printonly { display: none; }
button:disabled { opacity: .5; cursor: not-allowed; }
form.inline { display: inline; margin: 0; }
.runs { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.runs a { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; text-decoration: none; color: var(--fg); }
.runs .when { color: var(--muted); font-size: .85rem; }
.pill { display: inline-block; font-size: .75rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
.pill-running { color: var(--ev-reported); } .pill-done { color: var(--ev-primary); }
.pill-failed, .pill-interrupted { color: var(--ev-unsourced); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
.error { background: var(--warn-bg); color: var(--warn-fg); border-radius: 10px; padding: 12px 14px; }
input[type=file] { padding: 10px; }
.names { margin: 0; padding-left: 22px; }
.names .desig { font-size: .85rem; }
fieldset.plain { border: 0; padding: 0; margin: 0; display: grid; gap: 2px; }
fieldset.plain legend { font-weight: 600; font-size: .95rem; padding: 0; margin-bottom: 4px; }
label.check { display: flex; align-items: center; gap: 10px; min-height: 44px; }
label.check input { width: 24px; height: 24px; margin: 0; flex: none; }
.tabs { display: flex; gap: 4px; margin: 12px 0; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
.tabs a { flex: 1; text-align: center; padding: 10px 4px; border-radius: 9px; text-decoration: none; font-weight: 600; font-size: .92rem; min-height: 44px; }
.tabs a[aria-current=page] { background: var(--accent); color: var(--accent-fg); }
.tabs .count { font-weight: 400; opacity: .85; }
.items, .picks { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.item, .picks > li { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0 14px; scroll-margin-top: 12px; }
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
details.settings { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0 14px; }
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
.walk { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; margin: 12px 0; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.walk a { display: flex; align-items: center; gap: 4px; min-height: 44px; padding: 6px 10px; text-decoration: none; font-weight: 600; font-size: .9rem; min-width: 0; }
.walk span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.walk .next { justify-content: flex-end; }
.walk .mid { color: var(--muted); font-weight: 400; }
.priorities { border: 1px solid var(--line); border-radius: 10px; padding: 0 12px 10px; margin-top: 16px; }
h5 { font-size: 1rem; margin: 16px 0 4px; }
.st { margin: 4px 0 0; }
details.ctx { display: inline-block; }
details.ctx[open] { display: inline; }
details.ctx > summary, .ctx-eg { display: inline-block; list-style: none; font-size: .72rem; font-weight: 700; line-height: 1.5; color: var(--accent); border: 1px solid currentColor; border-radius: 999px; padding: 2px 8px; margin: 0 2px 0 4px; vertical-align: 1px; }
details.ctx > summary { min-width: 32px; text-align: center; }
details.ctx > summary::-webkit-details-marker { display: none; }
details.ctx[open] > summary { background: var(--accent); color: var(--accent-fg); }
.ctx-body { display: block; font-size: .9rem; border-left: 3px solid var(--accent); padding: 4px 10px; margin: 6px 0; }
.ctx-body .meta { display: block; }
.stance { margin: 4px 0; padding: 4px 10px; border-left: 4px solid currentColor; font-size: .95rem; }
.card .stance { font-size: .85rem; }
.stance .basis { color: var(--fg); }
.stance-conflicts { color: var(--ev-unsourced); } .stance-aligns { color: var(--ev-primary); }
.stance-mixed { color: var(--ev-opinion); } .stance-unclear { color: var(--muted); }
.measure-q { white-space: pre-line; }
/* Last, so it wins over the screen rules above. */
@media print { nav.top, .actions, .noprint, .tabs, .walk, .bar, .picks summary::after { display: none; } .picks > li { padding: 4px 14px; } .printonly { display: block; } body { font-size: 12pt; } .picks li { break-inside: avoid; } }
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
  const back = opts.back ?? { href: `${base}/#new`, label: "New race" };
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
</body>
</html>
`;
}

/** "2026-11-03" -> "Nov 3, 2026". Falls back to the input if it isn't a date. */
export function readableDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", {
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
  extra: { status?: string; actions?: string; mine?: string } = {},
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
  const notes = r.context?.notes ?? [];

  return `<h1>${esc(raceTitle(r))}</h1>
<p class="sub">${esc(q.city)}, ${esc(q.state)} · Candidate list from ${source} · Researched ${
    esc(readableDate(r.generated_at.slice(0, 10)))
  }</p>
${extra.status ?? ""}
${extra.actions ?? ""}

<div class="banner"><p><strong>This page does not rank, score, or recommend anyone.</strong> Every candidate gets the same sections and the same research instructions. Each fact links to where it came from and is tagged by the kind of evidence behind it.</p>
<details><summary>What this research can't see (${r.standing_gaps.length})</summary>
<ul>${r.standing_gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></details></div>

${askedAbout(r.priorities, "Every candidate was asked about the same issues, in the same words.")}
<h2>${r.listing.contest_kind === "retention" ? "On the ballot" : "Candidates"}</h2>
<p class="sub">${ORDER_LABEL[r.listing.order_basis]}${
    r.listing.notes ? ` ${esc(r.listing.notes)}` : ""
  }</p>
${inc ? `<p class="note">${esc(inc)}</p>` : ""}
${empty}
<ul class="cards">${r.candidates.map(overviewCard).join("")}</ul>

${r.candidates.map((d, i) => dossierSection(d, notes, r.candidates[i + 1])).join("")}
${namesHtml(r.context)}

${extra.mine ?? ""}
<footer>
<p>Evidence tags: <strong>Primary record</strong> is a government or official document. <strong>Reported</strong> is journalism describing events. <strong>Opinion / claim</strong> covers endorsements, editorials, and candidates' own statements. <strong>Unsourced</strong> is asserted without support.</p>
<p>A fact marked "reported by N sources" was stated by that many different outlets; it is shown once, with each of them. More sources means wider reporting, not that it is truer or more important.</p>
<p>Generated by Ballot Fix using AI-assisted web research${
    model ? ` (${esc(model)})` : ""
  }. It can be wrong. Check anything that matters to your vote at the linked source.</p>
</footer>`;
}

function askedAbout(issues: readonly string[] | undefined, same: string): string {
  if (!issues?.length) return "";
  return `<p class="note"><strong>You asked about:</strong> ${
    issues.map(esc).join("; ")
  }. ${same} Findings on them come first. Where your wording states a view, each issue is marked as conflicting with it, matching it, or mixed, but only when a verified source backs that up. That is a reading of the cited record, not a recommendation, and there is no overall score: open the sources before relying on it.</p>`;
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
  extra: { status?: string; actions?: string; mine?: string; stopped?: boolean } = {},
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
  const notes = d.context?.notes ?? [];
  const body = d.status === "pending"
    ? `<p class="gap">${
      extra.stopped
        ? "Research on this measure stopped before it finished. Research it again to fill this in."
        : "Research on this measure is still running. This page updates on its own."
    }</p>`
    : `${prioritiesHtml(d.priorities, "measure", notes)}
${MEASURE_SECTIONS.map((s) => sectionHtml(s.title, d.sections[s.id], notes)).join("")}
${gapsAndUnverified(d.gaps, d.unverified, notes)}
${namesHtml(d.context)}`;

  return `<h1>${esc(measureTitle(q))}</h1>
<p class="sub">${esc(q.jurisdiction || "Jurisdiction not read")}, ${esc(q.state)} · Researched ${
    esc(readableDate(d.generated_at.slice(0, 10)))
  }</p>
${official}
${extra.status ?? ""}
${extra.actions ?? ""}

<div class="banner"><p><strong>This page does not recommend a yes or no vote.</strong> Every measure gets the same sections, and the case for and the case against are researched with the same instructions. Each fact links to where it came from and is tagged by the kind of evidence behind it.</p>
<details><summary>What this research can't see (${d.standing_gaps.length})</summary>
<ul>${d.standing_gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></details></div>
${
    askedAbout(
      d.priority_issues,
      "Supporters' and opponents' claims about them were sought equally.",
    )
  }
${d.status === "ok" ? stanceSummary(d.priorities, "measure") : ""}
${question}
${identity}
<article class="dossier">
${body}
</article>

${extra.mine ?? ""}
<footer>
<p>Evidence tags: <strong>Primary record</strong> is a government or official document. <strong>Reported</strong> is journalism describing events. <strong>Opinion / claim</strong> covers endorsements, editorials, ballot arguments, and campaigns' own statements. <strong>Unsourced</strong> is asserted without support.</p>
<p>A fact marked "reported by N sources" was stated by that many different outlets; it is shown once, with each of them. More sources means wider reporting, not that it is truer or more important.</p>
<p>Generated by Ballot Fix using AI-assisted web research${
    d.model ? ` (${esc(d.model)})` : ""
  }. It can be wrong. Check anything that matters to your vote at the linked source.</p>
</footer>`;
}

export function renderMeasure(d: MeasureDossier): string {
  return page(measureTitle(d.query), measureBody(d));
}
