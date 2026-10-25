/**
 * Renders a RaceDossier as one self-contained HTML page.
 *
 * Every string that came from research is untrusted: it is HTML-escaped, and
 * only http(s) URLs ever become links. The page has no scripts at all.
 */

import { coveredSections, incumbencyNote } from "./dossier.ts";
import { MEASURE_SECTIONS, SECTIONS } from "./template.ts";
import type {
  CandidateDossier,
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

function factItem(f: Fact): string {
  const meta = [
    link(f.source_url, f.source_name),
    f.author ? `by ${esc(f.author)}` : "author not stated",
    f.published ? esc(f.published) : "date not stated",
  ].join(" · ");
  return `<li class="fact">
  <span class="ev ev-${f.evidence_type}">${EVIDENCE_LABEL[f.evidence_type]}</span>
  <p>${esc(f.statement)}</p>
  <p class="meta">${meta}</p>
</li>`;
}

function overviewCard(d: CandidateDossier): string {
  const c = d.candidate;
  const covered = coveredSections(d);
  const total = SECTIONS.length;
  const status = d.status === "failed"
    ? `<p class="cov cov-fail">Research failed in this run. Nothing about this candidate was checked.</p>`
    : d.status === "pending"
    ? `<p class="cov cov-pending">Researching now…</p>`
    : `<p class="cov">Sourced facts found in ${covered} of ${total} sections.</p>`;
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
  tag = "h4",
  between = "",
): string {
  r ??= NOT_IN_THIS_RUN;
  const facts = r.facts.length ? `<ul class="facts">${r.facts.map(factItem).join("")}</ul>` : "";
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
  const yes = subject === "measure" ? "A yes vote " : "";
  switch (st) {
    case "conflicts":
      return subject === "measure" ? `${yes}conflicts with your view` : "Conflicts with your view";
    case "aligns":
      return subject === "measure" ? `${yes}matches your view` : "Matches your view";
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
function prioritiesHtml(p: readonly PriorityResult[] | undefined, subject: Subject): string {
  if (!p?.length) return "";
  return `<section class="priorities"><h4>On what you said matters to you</h4>${
    p.map((x) => sectionHtml(x.issue, x.result, "h5", stanceBadge(x, subject))).join("")
  }</section>`;
}

/**
 * The quick read on the overview: which of the voter's stated views the
 * record conflicts with or matches, conflicts first. Same rule for everyone.
 */
function stanceSummary(p: readonly PriorityResult[] | undefined, subject: Subject): string {
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

function gapsAndUnverified(gaps: readonly string[], unverified: readonly Fact[]): string {
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
<ul class="facts">${unverified.map(factItem).join("")}</ul></details>`
    : "";
  return g + u;
}

function dossierSection(d: CandidateDossier): string {
  const c = d.candidate;
  if (d.status === "pending") {
    return `<article class="dossier pending" id="${slug(c.name)}">
  <h2>${esc(c.name)}</h2>
  <p class="gap">Research on this candidate is still running. This page updates on its own.</p>
</article>`;
  }
  const sections = SECTIONS.map((s) => sectionHtml(s.title, d.sections[s.id])).join("");

  const identity = d.identity_note
    ? `<p class="note"><strong>Identity check.</strong> ${esc(d.identity_note)}</p>`
    : "";

  return `<article class="dossier" id="${slug(c.name)}">
  <h2>${esc(c.name)}</h2>
  <p class="desig">${
    c.ballot_designation ? esc(c.ballot_designation) : "Ballot designation not found"
  }${c.incumbent ? ` · <span class="inc">Incumbent</span>` : ""}</p>
  ${identity}
  ${prioritiesHtml(d.priorities, "candidate")}
  ${sections}
  ${gapsAndUnverified(d.gaps, d.unverified)}
  <p class="back"><a href="#top">Back to all candidates</a></p>
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
.picks { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.picks li { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.picks .pick { font-size: 1.1rem; font-weight: 700; margin: 4px 0; }
.picks .undecided { color: var(--muted); font-style: italic; font-weight: 400; }
.picks .notes { white-space: pre-line; margin: 4px 0 0; }
@media print { nav.top, .actions, .noprint { display: none; } body { font-size: 12pt; } .picks li { break-inside: avoid; } }
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
.contests { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.contest { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: grid; gap: 6px; }
.contest p { margin: 0; }
.names { margin: 0; padding-left: 22px; }
.names .desig { font-size: .85rem; }
fieldset.plain { border: 0; padding: 0; margin: 0; display: grid; gap: 2px; }
fieldset.plain legend { font-weight: 600; font-size: .95rem; padding: 0; margin-bottom: 4px; }
label.check { display: flex; align-items: center; gap: 10px; min-height: 44px; }
label.check input { width: 24px; height: 24px; margin: 0; flex: none; }
.contest details { display: grid; gap: 10px; }
.contest details label { margin-top: 10px; }
.priorities { border: 1px solid var(--line); border-radius: 10px; padding: 0 12px 10px; margin-top: 16px; }
h5 { font-size: 1rem; margin: 16px 0 4px; }
.stance { margin: 4px 0; padding: 4px 10px; border-left: 4px solid currentColor; font-size: .95rem; }
.card .stance { font-size: .85rem; }
.stance .basis { color: var(--fg); }
.stance-conflicts { color: var(--ev-unsourced); } .stance-aligns { color: var(--ev-primary); }
.stance-mixed { color: var(--ev-opinion); } .stance-unclear { color: var(--muted); }
.measure-q { white-space: pre-line; }
`;

export interface PageOptions {
  /** Reload the page every N seconds (used while research is running). No script needed. */
  refreshSeconds?: number;
  /** Show the app's top bar with a link home. Off for exported static files. */
  nav?: boolean;
  /** Mount prefix (e.g. "/ballotfix") for the nav's home links. Empty when served at root. */
  base?: string;
}

/** Full HTML document with a strict CSP: no scripts, no external resources. */
export function page(title: string, body: string, opts: PageOptions = {}): string {
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${Math.max(2, Math.floor(opts.refreshSeconds))}">`
    : "";
  const base = opts.base ?? "";
  const nav = opts.nav
    ? `<nav class="top"><a href="${base}/">Ballot Fix</a><a href="${base}/#new">New race</a></nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'">
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

  return `<h1>${esc(raceTitle(r))}</h1>
<p class="sub">${esc(q.city)}, ${esc(q.state)} · Candidate list from ${source} · Researched ${
    esc(r.generated_at.slice(0, 10))
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

${r.candidates.map(dossierSection).join("")}

${extra.mine ?? ""}
<footer>
<p>Evidence tags: <strong>Primary record</strong> is a government or official document. <strong>Reported</strong> is journalism describing events. <strong>Opinion / claim</strong> covers endorsements, editorials, and candidates' own statements. <strong>Unsourced</strong> is asserted without support.</p>
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
  extra: { status?: string; actions?: string; mine?: string } = {},
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
  const body = d.status === "pending"
    ? `<p class="gap">Research on this measure is still running. This page updates on its own.</p>`
    : `${prioritiesHtml(d.priorities, "measure")}
${MEASURE_SECTIONS.map((s) => sectionHtml(s.title, d.sections[s.id])).join("")}
${gapsAndUnverified(d.gaps, d.unverified)}`;

  return `<h1>${esc(measureTitle(q))}</h1>
<p class="sub">${esc(q.jurisdiction || "Jurisdiction not read")}, ${esc(q.state)} · Researched ${
    esc(d.generated_at.slice(0, 10))
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
<p>Generated by Ballot Fix using AI-assisted web research${
    d.model ? ` (${esc(d.model)})` : ""
  }. It can be wrong. Check anything that matters to your vote at the linked source.</p>
</footer>`;
}

export function renderMeasure(d: MeasureDossier): string {
  return page(measureTitle(d.query), measureBody(d));
}
