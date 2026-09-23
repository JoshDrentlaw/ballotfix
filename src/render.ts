/**
 * Renders a RaceDossier as one self-contained HTML page.
 *
 * Every string that came from research is untrusted: it is HTML-escaped, and
 * only http(s) URLs ever become links. The page has no scripts at all.
 */

import { coveredSections, incumbencyNote } from "./dossier.ts";
import { SECTIONS } from "./template.ts";
import type { CandidateDossier, EvidenceType, Fact, OrderBasis, RaceDossier } from "./types.ts";

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
    : `<p class="cov">Sourced facts found in ${covered} of ${total} sections.</p>`;
  return `<li class="card">
  <h3><a href="#${slug(c.name)}">${esc(c.name)}</a></h3>
  <p class="desig">${
    c.ballot_designation ? esc(c.ballot_designation) : "Ballot designation not found"
  }${c.incumbent ? ` · <span class="inc">Incumbent</span>` : ""}</p>
  ${status}
</li>`;
}

function dossierSection(d: CandidateDossier): string {
  const c = d.candidate;
  const sections = SECTIONS.map((s) => {
    const r = d.sections[s.id];
    const facts = r.facts.length ? `<ul class="facts">${r.facts.map(factItem).join("")}</ul>` : "";
    const gap = r.gap_note ? `<p class="gap">${esc(r.gap_note)}</p>` : "";
    const searched = r.searched.length
      ? `<p class="searched">Looked at: ${r.searched.map(esc).join("; ")}</p>`
      : "";
    return `<section class="sec"><h4>${esc(s.title)}</h4>${facts}${gap}${searched}</section>`;
  }).join("");

  const identity = d.identity_note
    ? `<p class="note"><strong>Identity check.</strong> ${esc(d.identity_note)}</p>`
    : "";
  const gaps = d.gaps.length
    ? `<section class="sec"><h4>What this run couldn't check</h4><ul class="gaps">${
      d.gaps.map((g) => `<li>${esc(g)}</li>`).join("")
    }</ul></section>`
    : "";
  const unverified = d.unverified.length
    ? `<details class="unverified"><summary>${d.unverified.length} claim${
      d.unverified.length === 1 ? "" : "s"
    } not shown above because the cited page was never retrieved in this run</summary>
<p>These cite a URL the research session did not actually open, so they can't be traced. Treat them as leads to check yourself, not findings.</p>
<ul class="facts">${d.unverified.map(factItem).join("")}</ul></details>`
    : "";

  return `<article class="dossier" id="${slug(c.name)}">
  <h2>${esc(c.name)}</h2>
  <p class="desig">${
    c.ballot_designation ? esc(c.ballot_designation) : "Ballot designation not found"
  }${c.incumbent ? ` · <span class="inc">Incumbent</span>` : ""}</p>
  ${identity}
  ${sections}
  ${gaps}
  ${unverified}
  <p class="back"><a href="#top">Back to all candidates</a></p>
</article>`;
}

export function renderRace(r: RaceDossier): string {
  const q = r.query;
  const title = `${q.city} ${q.office}, ${q.electionDate}`;
  const inc = incumbencyNote(r.listing);
  const source = r.listing.source_url
    ? link(r.listing.source_url, r.listing.source_name)
    : esc(r.listing.source_name);
  const empty = r.candidates.length === 0
    ? `<p class="gap">No candidates were found for this race. ${
      r.listing.notes ? esc(r.listing.notes) : ""
    }</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
:root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#5d5b55; --line:#e2dfd7; --card:#ffffff;
  --accent:#28536b; --warn-bg:#fff4e0; --warn-fg:#6b4300;
  --ev-primary:#1f6f43; --ev-reported:#28536b; --ev-opinion:#7a4d9c; --ev-unsourced:#8a3b2e; }
@media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --muted:#a8a69e;
  --line:#34332f; --card:#1f1f1c; --accent:#8cc0dc; --warn-bg:#3a2c12; --warn-fg:#f3d39b;
  --ev-primary:#7fd3a3; --ev-reported:#8cc0dc; --ev-opinion:#c9a3e6; --ev-unsourced:#f0a090; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.35rem; margin: 0; }
h3 { font-size: 1.05rem; margin: 0 0 2px; }
h4 { font-size: 0.95rem; margin: 20px 0 6px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
a { color: var(--accent); }
.sub, .desig, .meta, .searched, .cov { color: var(--muted); }
.meta, .searched { font-size: .85rem; margin: 2px 0 0; }
.banner { background: var(--warn-bg); color: var(--warn-fg); border-radius: 8px; padding: 12px 14px; margin: 16px 0; }
.banner ul { margin: 6px 0 0; padding-left: 20px; }
.note { border-left: 3px solid var(--accent); padding: 4px 12px; margin: 12px 0; }
.cards { list-style: none; padding: 0; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.card p { margin: 2px 0; font-size: .9rem; }
.cov-fail { color: var(--ev-unsourced); }
.inc { font-weight: 600; color: var(--fg); }
.dossier { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px 16px; margin: 28px 0; }
.facts { list-style: none; padding: 0; margin: 0; }
.fact { border-top: 1px solid var(--line); padding: 10px 0; }
.fact p { margin: 4px 0 0; }
.ev { display: inline-block; font-size: .72rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
.ev-primary_record { color: var(--ev-primary); } .ev-reported { color: var(--ev-reported); }
.ev-opinion { color: var(--ev-opinion); } .ev-unsourced { color: var(--ev-unsourced); }
.gap { font-style: italic; color: var(--muted); margin: 4px 0; }
.gaps { margin: 0; padding-left: 20px; }
details.unverified { margin-top: 18px; border-top: 1px dashed var(--line); padding-top: 10px; }
summary { cursor: pointer; color: var(--muted); }
.back { margin: 16px 0 0; font-size: .9rem; }
footer { color: var(--muted); font-size: .85rem; margin-top: 40px; }
</style>
</head>
<body>
<main id="top">
<h1>${esc(title)}</h1>
<p class="sub">${esc(q.city)}, ${esc(q.state)} · Candidate list from ${source} · Researched ${
    esc(r.generated_at.slice(0, 10))
  }</p>

<div class="banner"><strong>This page does not rank, score, or recommend anyone.</strong> Every candidate gets the same sections and the same research instructions. Each fact links to where it came from and is tagged by the kind of evidence behind it.
<ul>${r.standing_gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>

<h2>Candidates</h2>
<p class="sub">${ORDER_LABEL[r.listing.order_basis]}${
    r.listing.notes ? ` ${esc(r.listing.notes)}` : ""
  }</p>
${inc ? `<p class="note">${esc(inc)}</p>` : ""}
${empty}
<ul class="cards">${r.candidates.map(overviewCard).join("")}</ul>

${r.candidates.map(dossierSection).join("")}

<footer>
<p>Evidence tags: <strong>Primary record</strong> is a government or official document. <strong>Reported</strong> is journalism describing events. <strong>Opinion / claim</strong> covers endorsements, editorials, and candidates' own statements. <strong>Unsourced</strong> is asserted without support.</p>
<p>Generated by Ballot Fix phase 0 using AI-assisted web research${
    r.candidates.find((c) => c.model) ? ` (${esc(r.candidates.find((c) => c.model)!.model!)})` : ""
  }. It can be wrong. Check anything that matters to your vote at the linked source.</p>
</footer>
</main>
</body>
</html>
`;
}
