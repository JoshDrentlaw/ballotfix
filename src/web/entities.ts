/**
 * Entity pages: what the knowledge graph (src/knowledge.ts, src/web/kb.ts)
 * holds on one person, organization, office, measure, or measure side,
 * across every finished run in its place, plus a name search within a place.
 *
 * Read-only and local: GET pages built from the graph, no model or network
 * calls. The same invariants as the race pages hold here:
 * - Everything from research is escaped; only http(s) URLs become links.
 * - Every fact shows each of its citations, its evidence tag, and the run
 *   it came from with when that run was researched.
 * - Unverified claims stay collapsed and apart.
 * - Nothing is scored, summed, or ranked: sections come in template order,
 *   facts newest run first, and names, contributions, and comparisons in
 *   alphabetical order, never by amount or by how much is tied to them.
 * - Entities are never merged here: one kept to one run says so, and
 *   same-named entities in other places are neither linked nor suggested.
 */

import {
  CONTEXT_SECTION,
  type ContributionDetail,
  type EntityKind,
  keptApart,
  keptToRun,
  nameKey,
  UNVERIFIED_SECTION,
} from "../knowledge.ts";
import {
  esc,
  EVIDENCE_LABEL,
  link,
  page,
  readableDate,
  readingGuide,
  sourceMeta,
  SUPPORT_TITLE,
} from "../render.ts";
import { MEASURE_SECTIONS, SECTIONS } from "../template.ts";
import type {
  Entity,
  GraphPair,
  GraphTie,
  KnowledgeBase,
  Link,
  StoredCitation,
  StoredClaim,
  StoredContribution,
} from "./kb.ts";

/** Search results shown at most; the page says when there are more. */
export const MAX_SEARCH_RESULTS = 200;
/** Longest search query accepted. */
export const MAX_QUERY_CHARS = 100;

/** A run as an entity page cites it: what it was and when it was researched. */
export interface RunInfo {
  id: string;
  title: string;
  /** When the run started (ISO): orders runs, newest first. */
  created_at: string;
  /** When its research finished (ISO date), as its own page says. */
  researched: string;
  /** A newer finished run of the same race or measure (a rerun), if any. */
  newer: string | null;
}

export interface Peer {
  entity: Entity;
  /** For a candidate: the offices they ran for, as the graph names them. */
  offices: string[];
  pair: GraphPair;
}

export interface EntityView {
  entity: Entity;
  claims: StoredClaim[];
  /** What each claim naming this entity is about. */
  subjects: Map<number, Entity[]>;
  contributions: StoredContribution[];
  links: Link[];
  /** Every run this entity appears in, and how. */
  runs: Map<string, Set<string>>;
  runInfo: Map<string, RunInfo>;
  /** For a candidate or a measure side: every other one in the same place. Null otherwise. */
  peers: Peer[] | null;
}

const byName = (a: Entity, b: Entity) =>
  nameKey(a.name).localeCompare(nameKey(b.name)) || a.key.localeCompare(b.key);

/** Everything an entity page shows, read from the graph and the runs it cites. */
export async function entityView(
  kb: KnowledgeBase,
  runInfo: (id: string) => Promise<RunInfo | null>,
  entity: Entity,
): Promise<EntityView> {
  const claims = kb.claimsAbout(entity.id);
  const subjects = kb.subjectsOf(claims.filter((c) => c.role === "named").map((c) => c.id));
  const others = kb.peersOf(entity);
  const own = others?.length ? kb.tiesOf(entity.id) : undefined;
  const peers = others
    ? others.map((p): Peer => ({
      entity: p,
      offices: [
        ...new Set(
          kb.linksOf(p.id).filter((l) => l.relation === "candidate_for" && l.direction === "out")
            .map((l) => l.other.name),
        ),
      ].sort(),
      pair: kb.between(entity, p, own),
    }))
    : null;
  const runs = kb.runsOf(entity.id);
  const ids = new Set(runs.keys());
  for (const p of peers ?? []) {
    for (const s of p.pair.shared) for (const t of [...s.a, ...s.b]) ids.add(t.run_id);
  }
  const info = new Map<string, RunInfo>();
  for (const id of ids) {
    const r = await runInfo(id);
    if (r) info.set(id, r);
  }
  return {
    entity,
    claims,
    subjects,
    contributions: kb.contributionsOf(entity.id),
    links: kb.linksOf(entity.id),
    runs,
    runInfo: info,
    peers,
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<EntityKind, string> = {
  person: "Person",
  organization: "Organization",
  office: "Office",
  measure: "Measure",
  side: "Measure side",
};

/** "Individual contributor" for a person known only from a filing. */
function kindLabel(e: Entity): string {
  return keptApart(e.key) === "row" || keptApart(e.key) === "work"
    ? "Individual contributor"
    : KIND_LABEL[e.kind];
}

function entityHref(e: Entity, base: string): string {
  return `${base}/entities/${esc(e.slug)}`;
}

function entityLink(e: Entity, base: string): string {
  return `<a href="${entityHref(e, base)}">${esc(e.name)}</a>`;
}

function runRef(id: string, runs: Map<string, RunInfo>, base: string): string {
  const r = runs.get(id);
  if (!r) return "from a run no longer saved";
  return `from <a href="${base}/races/${esc(r.id)}">${esc(r.title)}</a>, researched ${
    esc(readableDate(r.researched))
  }${
    r.newer
      ? ` (<a href="${base}/races/${
        esc(r.newer)
      }">researched again since</a>; this fact may be out of date)`
      : ""
  }`;
}

/**
 * Which run a fact came from. When everything on the page comes from one run,
 * that is said once above the facts instead of under each one.
 */
function fromLine(id: string, v: EntityView, base: string): string {
  return v.runs.size === 1 ? "" : `<p class="meta from">${runRef(id, v.runInfo, base)}</p>`;
}

/** When everything on the page comes from one run, it is named once, here. */
function oneRunHtml(v: EntityView, base: string): string {
  return v.runs.size === 1
    ? `<p class="sub from">Everything on this page comes ${
      runRef([...v.runs.keys()][0], v.runInfo, base)
    }.</p>`
    : "";
}

function citationsHtml(cs: readonly StoredCitation[]): string {
  return cs.length === 1
    ? `<p class="meta">${sourceMeta(cs[0])}</p>`
    : `<ul class="meta srcs">${cs.map((c) => `<li>${sourceMeta(c)}</li>`).join("")}</ul>`;
}

/** Template section titles for every kind, plus the graph's own sections. */
function sectionTitle(c: StoredClaim): string {
  if (c.issue !== null && /^priority_\d+$/.test(c.section)) return `Voter's issue: ${c.issue}`;
  if (c.section === CONTEXT_SECTION) return "Context note";
  if (c.section === UNVERIFIED_SECTION) return "Unverified";
  return [...SECTIONS, ...MEASURE_SECTIONS].find((s) => s.id === c.section)?.title ?? c.section;
}

function claimItem(
  c: StoredClaim,
  v: EntityView,
  base: string,
  about = "",
): string {
  const n = c.citations.length;
  return `<li class="fact">
  <span class="ev ev-${c.evidence_type}">${EVIDENCE_LABEL[c.evidence_type]}</span>${
    n > 1 ? ` <span class="nsrc">Reported by ${n} sources</span>` : ""
  }
  ${about}<p>${esc(c.statement)}</p>
  ${citationsHtml(c.citations)}
  ${fromLine(c.run_id, v, base)}
</li>`;
}

/** The fixed list of sections a kind's facts are grouped under, the same for every entity of it. */
function sectionsFor(e: Entity): { id: string; title: string }[] {
  const context = { id: CONTEXT_SECTION, title: "Who or what this is (context notes)" };
  switch (e.kind) {
    case "person":
      return [context, ...SECTIONS];
    case "organization":
      return [context];
    case "measure":
      return [...MEASURE_SECTIONS];
    case "side":
      return MEASURE_SECTIONS.filter((s) =>
        s.id === (e.key.endsWith("|support") ? "case_for" : "case_against")
      );
    case "office":
      return [];
  }
}

const isPriority = (c: StoredClaim) => /^priority_\d+$/.test(c.section);

/** Verified facts about the entity, by section in template order, newest run first in each. */
function aboutHtml(v: EntityView, base: string): string {
  const about = v.claims.filter((c) => c.role === "subject" && c.verified);
  const groups = sectionsFor(v.entity);
  const known = new Set(groups.map((g) => g.id));
  const empty: string[] = [];
  const blocks = groups.map((g) => {
    const cs = about.filter((c) => c.section === g.id);
    if (!cs.length) {
      empty.push(g.title);
      return "";
    }
    return `<section class="sec"><h4>${esc(g.title)}</h4><ul class="facts">${
      cs.map((c) => claimItem(c, v, base)).join("")
    }</ul></section>`;
  }).join("");
  const priorities = about.filter(isPriority);
  const issues = priorities.length
    ? `<section class="sec"><h4>On issues voters asked about</h4><p class="sub">Each run asks about the issues the voter who started it named, so these differ from run to run.</p><ul class="facts">${
      priorities.map((c) => claimItem(c, v, base, `<p class="who-tag">${esc(c.issue ?? "")}</p>`))
        .join("")
    }</ul></section>`
    : "";
  // Never silently dropped: a section this list doesn't know still shows.
  const other = about.filter((c) => !known.has(c.section) && !isPriority(c));
  const rest = other.length
    ? `<section class="sec"><h4>Other facts</h4><ul class="facts">${
      other.map((c) => claimItem(c, v, base, `<p class="who-tag">${esc(sectionTitle(c))}</p>`))
        .join("")
    }</ul></section>`
    : "";
  const none = !groups.length
    ? `<p class="gap">The research holds no facts about ${
      v.entity.kind === "office" ? "an office itself" : "this"
    }; see who appears with it above.</p>`
    : empty.length
    ? `<p class="gap">Nothing in finished research for: ${empty.map(esc).join("; ")}.</p>`
    : "";
  return `<h2>Facts about it</h2>${blocks}${issues}${rest}${none}`;
}

/** Verified facts about something else that name this entity. */
function namedInHtml(v: EntityView, base: string): string {
  const named = v.claims.filter((c) => c.role === "named" && c.verified);
  if (!named.length) {
    return `<h2>Facts that name it</h2><p class="gap">No fact in finished research names it with a sourced note.</p>`;
  }
  return `<h2>Facts that name it</h2><p class="sub">Facts about someone or something else whose statement names it, newest research first.</p><ul class="facts">${
    named.map((c) => {
      const subjects = (v.subjects.get(c.id) ?? []).map((e) => entityLink(e, base));
      return claimItem(
        c,
        v,
        base,
        `<p class="who-tag">About ${subjects.join(", ") || "a subject no longer saved"} · ${
          esc(sectionTitle(c))
        }</p>`,
      );
    }).join("")
  }</ul>`;
}

function giftHtml(c: StoredContribution, v: EntityView, base: string): string {
  const d: ContributionDetail = c.detail;
  const who = c.direction === "received"
    ? `<strong>${entityLink(c.other, base)}</strong>`
    : `To <strong>${entityLink(c.other, base)}</strong>`;
  return `<li class="fact gift">
  <span class="ev ev-primary_record">Filing</span>
  <p>${who}: ${esc(d.amount)} · ${d.date ? esc(d.date) : "date not stated"}</p>
  <p class="meta">Filed by ${esc(d.filer)} · ${
    d.filing_period ? esc(d.filing_period) : "filing period not stated"
  }${d.filing ? ` · ${esc(d.filing)}` : ""}</p>
  ${
    c.citations.length === 1
      ? `<p class="meta">${link(c.citations[0].url, c.citations[0].source_name)}</p>`
      : `<ul class="meta srcs">${
        c.citations.map((x) => `<li>${link(x.url, x.source_name)}</li>`).join("")
      }</ul>`
  }
  ${fromLine(c.run_id, v, base)}
</li>`;
}

/** Alphabetical by the other party, then by run: never by amount, and never summed. */
function giftsSorted(cs: StoredContribution[], v: EntityView): StoredContribution[] {
  const at = (c: StoredContribution) => v.runInfo.get(c.run_id)?.created_at ?? "";
  return [...cs].sort((a, b) =>
    byName(a.other, b.other) || at(b).localeCompare(at(a)) || a.detail.row - b.detail.row
  );
}

function contributionsHtml(v: EntityView, base: string): string {
  const received = giftsSorted(v.contributions.filter((c) => c.direction === "received"), v);
  const made = giftsSorted(v.contributions.filter((c) => c.direction === "made"), v);
  const list = (cs: StoredContribution[], none: string) =>
    cs.length
      ? `<ul class="facts">${cs.map((c) => giftHtml(c, v, base)).join("")}</ul>`
      : `<p class="gap">${none}</p>`;
  return `<h2>Contributions</h2>
<p class="sub">Itemized contributions read from campaign finance filings that a run retrieved, each as the record states it, alphabetical by name. Nothing here is added up or ranked; amounts are the filings' own words. Contributions whose filing page was never retrieved aren't kept in the graph, so they don't appear here; see each run's page.</p>
<section class="sec"><h4>Received</h4>${list(received, "None in finished research.")}</section>
<section class="sec"><h4>Made</h4>${list(made, "None in finished research.")}</section>`;
}

/** Ballot relations: who ran for what, sides of a measure. Alphabetical by name. */
function ballotHtml(v: EntityView, base: string): string {
  const lines = v.links.flatMap((l): string[] => {
    const other = entityLink(l.other, base);
    const detail = l.detail
      ? ` (${esc(/^\d{4}-\d{2}-\d{2}$/.test(l.detail) ? readableDate(l.detail) : l.detail)})`
      : "";
    const from = v.runs.size === 1
      ? ""
      : ` <span class="meta">${runRef(l.run_id, v.runInfo, base)}</span>`;
    switch (`${l.relation} ${l.direction}`) {
      case "candidate_for out":
        return [`On the ballot for ${other}${detail}${from}`];
      case "candidate_for in":
        return [`${other} was on the ballot for it${detail}${from}`];
      case "holds out":
        return [`Listed as the incumbent in ${other}${detail}${from}`];
      case "holds in":
        return [`${other} was listed as its incumbent${detail}${from}`];
      case "side_of out":
        return [`One side of ${other}${from}`];
      case "side_of in":
        return [`${other}${from}`];
      default:
        return [];
    }
  });
  if (v.entity.kind === "organization" && !lines.length) return "";
  return `<h2>On the ballot</h2>${
    lines.length
      ? `<ul class="ballot-lines">${lines.map((x) => `<li>${x}</li>`).join("")}</ul>`
      : `<p class="gap">Not on a ballot in any finished research.</p>`
  }`;
}

function tieHtml(label: string, t: GraphTie, v: EntityView, base: string): string {
  const who = `<span class="who-tag">${esc(label)}:</span> `;
  const sources = t.citations.map((c) => link(c.url, c.source_name)).join("; ");
  const from = `<span class="meta">${runRef(t.run_id, v.runInfo, base)}</span>`;
  if (t.kind === "contribution") {
    const d = t.detail;
    return `<li>${who}contribution of ${esc(d.amount)}, ${
      d.date ? esc(d.date) : "date not stated"
    }, to ${esc(d.filer)}${
      d.filing_period ? ` (${esc(d.filing_period)})` : ""
    } · ${sources} · ${from}</li>`;
  }
  return `<li>${who}named in ${esc(SUPPORT_TITLE[t.section] ?? t.section)}: “${
    esc(t.statement)
  }” · ${sources} · ${from}</li>`;
}

function peerLabel(p: Peer): string {
  const parts = [
    p.entity.kind === "side"
      ? "measure side"
      : `candidate${p.offices.length ? ` for ${p.offices.join("; ")}` : ""}`,
    keptApart(p.entity.key) === "run" ? "kept to one run" : "",
  ].filter(Boolean);
  return parts.map(esc).join(" · ");
}

/**
 * Every other candidate or side in the same place, alphabetical, with what
 * each shares with this one by identity, and the near misses kept apart.
 * Collapsed. Every peer is accounted for; nothing is counted up or ranked.
 */
function sharedHtml(v: EntityView, base: string): string {
  const peers = v.peers;
  if (!peers) return "";
  const self = v.entity;
  const place = self.place || "this place";
  // One block per peer, all alphabetical: never grouped or ordered by what they share.
  const blocks = peers.map((p) => {
    const shared = p.pair.shared.length
      ? `<ul class="shared-list">${
        p.pair.shared.map((x) =>
          `<li><strong>${entityLink(x.entity, base)}</strong> <span class="desig">${
            esc(kindLabel(x.entity).toLowerCase())
          }</span><ul class="ties">${x.a.map((t) => tieHtml(self.name, t, v, base)).join("")}${
            x.b.map((t) => tieHtml(p.entity.name, t, v, base)).join("")
          }</ul></li>`
        ).join("")
      }</ul>`
      : `<p class="gap">No shared contributors or endorsers found.</p>`;
    const possible = p.pair.possible.map((m) =>
      `<p class="gap">Possibly the same, kept separate because the names or details don't match exactly: ${
        m.a.map(esc).join(" / ")
      } (${esc(self.name)}) and ${m.b.map(esc).join(" / ")} (${esc(p.entity.name)}).</p>`
    ).join("");
    return `<section class="pair"><h5>${entityLink(p.entity, base)} <span class="desig">${
      peerLabel(p)
    }</span></h5>${shared}${possible}</section>`;
  }).join("");
  const body = peers.length
    ? blocks
    : `<p class="gap">No other candidate or measure side in ${
      esc(place)
    } is in finished research yet.</p>`;
  return `<details class="shared sec"><summary>Shared with others in ${esc(place)}</summary>
<p>Every other candidate and measure side in ${
    esc(place)
  } that finished research holds, alphabetically, with the contributors and endorsers both have and where each tie comes from. A contributor counts only from a filing a run retrieved; an endorser only where a verified fact names someone with a sourced note. They are matched by identity only: the same exact name and kind in this place, and an individual also by the same stated occupation and employer, so close names are kept separate rather than guessed. Nobody in another place is compared, whatever their name. A shared name is a connection to look into, not a judgment of anyone.</p>
${body}</details>`;
}

const HOW: Record<string, string> = {
  claim_subject: "facts about it",
  claim_named: "named in facts",
  claim_subject_unverified: "unverified claims about it",
  claim_named_unverified: "named in unverified claims",
  candidate_for_out: "on the ballot",
  candidate_for_in: "the office on the ballot",
  holds_out: "listed as incumbent",
  holds_in: "the office its incumbent held",
  contributed_to_out: "contributions made",
  contributed_to_in: "contributions received",
  side_of_out: "a side of the measure",
  side_of_in: "the measure its sides are of",
};

/** Every run this page draws on, newest first, and how the entity appears in each. */
function runsHtml(v: EntityView, base: string): string {
  const at = (id: string) => v.runInfo.get(id)?.created_at ?? "";
  const ids = [...v.runs.keys()].sort((a, b) => at(b).localeCompare(at(a)) || a.localeCompare(b));
  return `<h2>Where this comes from</h2>
<p class="sub">Only finished research is included; a run that failed or is still running adds nothing. When a race or measure is researched again, the older run's facts stay here, marked, next to the newer run's.</p>
<ul class="runs-from">${
    ids.map((id) => {
      const how = [...v.runs.get(id)!].map((h) => HOW[h] ?? h).sort();
      return `<li>${runRef(id, v.runInfo, base).replace(/^from /, "")}<br><span class="meta">${
        esc(how.join("; "))
      }</span></li>`;
    }).join("")
  }</ul>`;
}

/** Unverified claims about or naming the entity: collapsed and apart, as on race pages. */
function unverifiedHtml(v: EntityView, base: string): string {
  const u = v.claims.filter((c) => !c.verified);
  if (!u.length) return "";
  return `<details class="unverified"><summary>${u.length} claim${
    u.length === 1 ? "" : "s"
  } not shown above because the cited page was never retrieved</summary>
<p>These cite a URL the research session did not actually open, so they can't be traced. Treat them as leads to check yourself, not findings.</p>
<ul class="facts">${
    u.map((c) =>
      claimItem(
        c,
        v,
        base,
        c.role === "named"
          ? `<p class="who-tag">Names it; about ${
            (v.subjects.get(c.id) ?? []).map((e) => entityLink(e, base)).join(", ") ||
            "a subject no longer saved"
          }</p>`
          : "",
      )
    ).join("")
  }</ul></details>`;
}

function identityHtml(v: EntityView, base: string): string {
  const e = v.entity;
  const kept = keptApart(e.key);
  const runs = [...v.runs.keys()];
  const only = runs.length === 1 ? runRef(runs[0], v.runInfo, base) : "";
  const note = kept === "run"
    ? `<strong>Kept to one run.</strong> That run's research flagged that someone else may share this name, so nothing from other runs is joined to this page, even under the same name${
      only ? `. It comes ${only}` : ""
    }.`
    : kept === "row"
    ? `<strong>Kept to one contribution.</strong> The filing gives no occupation and employer that would tell same-named people apart, so this contributor isn't joined with anyone else, even under the same name${
      only ? `. It comes ${only}` : ""
    }.`
    : kept === "work"
    ? `<strong>Matched on stated work.</strong> Contributions are joined here only where the filing names this person with the same occupation and employer.`
    : "";
  return `${note ? `<p class="note">${note}</p>` : ""}<p class="sub">Same-named ${
    e.kind === "organization" ? "organizations" : "entries"
  } in other places are never joined to this page or suggested here.</p>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function entityPage(v: EntityView, base = ""): string {
  const e = v.entity;
  const body = `<h1>${esc(e.name)}</h1>
<p class="sub">${esc(kindLabel(e))}${
    e.place ? ` · ${esc(e.place)}` : ""
  } · <a href="${base}/entities?place=${
    encodeURIComponent(e.scope)
  }">Look up another name here</a></p>
<div class="banner info"><p><strong>This page does not rank, score, or recommend anyone.</strong> It gathers what Ballot Fix's finished research holds on this ${
    esc(kindLabel(e).toLowerCase())
  }, across every run in ${
    esc(e.place || "this place")
  }. Each fact links to where it came from, is tagged by the kind of evidence behind it, and says which run found it and when.</p>
${readingGuide("candidates' and campaigns' own statements")}</div>
${identityHtml(v, base)}
${oneRunHtml(v, base)}
${ballotHtml(v, base)}
${aboutHtml(v, base)}
${namedInHtml(v, base)}
${contributionsHtml(v, base)}
${sharedHtml(v, base)}
${runsHtml(v, base)}
${unverifiedHtml(v, base)}
<footer>
<p>Built from AI-assisted web research. It can be wrong. Check anything that matters to your vote at the linked source.</p>
</footer>`;
  return page(e.name, body, {
    nav: true,
    base,
    back: {
      href: `${base}/entities?place=${encodeURIComponent(e.scope)}`,
      label: "Look up a name",
    },
  });
}

/** ": Example Mayor · Nov 3, 2026, researched Oct 27, 2026" for an entity kept to one run. */
function keptRun(e: Entity, runs: Map<number, RunInfo> | undefined): string {
  const r = runs?.get(e.id);
  return r ? `: ${r.title}, researched ${readableDate(r.researched)}` : "";
}

/** The run an entity kept to one run belongs to, read off its key (personRef). */
export function keptRunId(e: Entity): string | null {
  return keptToRun(e.key);
}

export interface SearchOptions {
  places: { scope: string; place: string }[];
  /** The chosen place's scope, if it is one of `places`. */
  scope: string | null;
  query: string;
  /** Alphabetical; null when nothing was searched. */
  results: Entity[] | null;
  /** For an entity kept to one run: that run, so same-named results can be told apart. */
  runOf?: Map<number, RunInfo>;
  base?: string;
}

export function searchPage(o: SearchOptions): string {
  const base = o.base ?? "";
  const title = "Look up a name";
  if (!o.places.length) {
    return page(
      title,
      `<h1>${title}</h1><p class="sub">Nothing to look up yet. People, organizations, offices, and measures appear here once research on a race or measure finishes.</p>`,
      { nav: true, base },
    );
  }
  const options = o.places.map((p) =>
    `<option value="${esc(p.scope)}"${p.scope === o.scope ? " selected" : ""}>${
      esc(p.place)
    }</option>`
  ).join("");
  const place = o.places.find((p) => p.scope === o.scope)?.place ?? "";
  const shown = o.results?.slice(0, MAX_SEARCH_RESULTS) ?? [];
  const results = o.results === null
    ? ""
    : o.results.length
    ? `<h2>${
      o.query
        ? `Names in ${esc(place)} containing “${esc(o.query)}”`
        : `Everything in ${esc(place)}`
    }</h2>
<p class="sub">Alphabetical. ${
      o.results.length > MAX_SEARCH_RESULTS
        ? `Showing the first ${MAX_SEARCH_RESULTS} of ${o.results.length}; type more of the name to narrow it.`
        : ""
    }</p>
<ul class="who">${
      shown.map((e) =>
        `<li><a class="who-name" href="${entityHref(e, base)}">${esc(e.name)} <span class="desig">${
          [
            kindLabel(e),
            keptApart(e.key) === "run" ? `kept to one run${keptRun(e, o.runOf)}` : "",
          ].filter(Boolean).map(esc).join(" · ")
        }</span></a></li>`
      ).join("")
    }</ul>`
    : `<p class="gap">No name in ${esc(place)} contains “${
      esc(o.query)
    }”. Only finished research is searched, one place at a time.</p>`;
  const body = `<h1>${title}</h1>
<p class="sub">Search the people, organizations, offices, and measures that finished research holds, one place at a time. Results are alphabetical. Same-named entries in different places are separate and never mixed.</p>
<form class="stack" method="get" action="${base}/entities">
  <label>Place <select name="place" required>${
    o.scope ? "" : `<option value="" selected>Choose a place</option>`
  }${options}</select></label>
  <label>Name <span class="hint">Part of a name is enough. Leave empty to list the place.</span>
    <input name="q" maxlength="${MAX_QUERY_CHARS}" value="${
    esc(o.query)
  }" autocomplete="off"></label>
  <button type="submit">Search</button>
</form>
${results}`;
  return page(title, body, { nav: true, base });
}
