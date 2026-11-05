/**
 * How results (src/results.ts) are shown: the counts in ballot order, never
 * ranked and never with a winner named, each with its source, the source's
 * own time and status, when it was read, and whether it can still change.
 * Used by the ballot's Results tab and by race and measure pages.
 */

import { esc, link } from "../render.ts";
import { certifyDates } from "../results.ts";
import { nameKey } from "../knowledge.ts";
import type { StoredCheck, StoredResult } from "./store.ts";

/** "2026-11-04T06:38:00Z" -> "Nov 4, 2026, 6:38 AM UTC". */
export function readTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : `${
    d.toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  } UTC`;
}

/** "2026-12-03" -> "Dec 3, 2026". */
function day(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const pct = (p: number | null) => (p === null ? "—" : `${p.toFixed(p % 1 ? 1 : 0)}%`);

/**
 * Where the count stands: the source's own status where it states one, and
 * when it certifies by law. Never "final" on our own say.
 */
export function standing(r: StoredResult, electionDate: string | null, now: Date): string {
  const dates = electionDate ? certifyDates(electionDate) : null;
  const by = dates ? (r.count.source === "county" ? dates.county : dates.state) : null;
  const past = by ? now.toISOString().slice(0, 10) > by : false;
  const who = r.count.source === "county" ? "the county" : "the Secretary of State";
  const partial = r.partial
    ? `Only ${r.count.source_name}'s count: the Secretary of State's feed gave no count for this contest, so votes cast in other counties aren't in it. `
    : "";
  const own = r.count.status ? `The source says “${r.count.status}”. ` : "";
  const law = !by
    ? "Unofficial until certified."
    : past
    ? `Read after ${who}'s certification deadline (${day(by)}); ${
      r.count.status
        ? "the status above is the source's own"
        : "the feed doesn't say whether this is the certified count"
    }.`
    : `Unofficial until ${who} certifies, by ${day(by)}; it can still change.`;
  return `${partial}${own}${law}`;
}

/** The count in ballot order: each ballot choice with its votes and share, the voter's pick marked. */
export function resultTable(
  r: StoredResult,
  names: readonly string[],
  picks: readonly string[] = [],
): string {
  const picked = new Set(picks.map(nameKey));
  const used = new Set<number>();
  const rows = names.map((name, i) => {
    const at = r.order[i];
    const c = at === null || at === undefined ? null : r.count.choices[at];
    if (at !== null && at !== undefined) used.add(at);
    const mine = picked.has(nameKey(name)) ? ` <span class="your-pick">your pick</span>` : "";
    return `<tr><th scope="row">${esc(name)}${mine}</th><td class="num">${
      c ? c.votes.toLocaleString("en-US") : "—"
    }</td><td class="num">${c ? pct(c.percent) : "—"}</td><td class="bar-cell" aria-hidden="true">${
      c?.percent !== null && c?.percent !== undefined
        ? `<span class="bar" style="width:${Math.max(0, Math.min(100, c.percent))}%"></span>`
        : ""
    }</td></tr>`;
  }).join("");
  // Qualified write-ins and anyone else the count lists that the ballot doesn't.
  const extra = r.count.choices.filter((_, i) => !used.has(i));
  return `<table class="votes"><thead><tr><th scope="col">${
    names.length === 2 && /^yes$/i.test(names[0]) ? "Vote" : "Candidate, in ballot order"
  }</th><th scope="col" class="num">Votes</th><th scope="col" class="num">Share</th><th class="bar-cell" aria-hidden="true"></th></tr></thead><tbody>${rows}${
    extra.map((c) =>
      `<tr class="extra"><th scope="row">${
        esc(c.name)
      } <span class="desig">not on your ballot</span></th><td class="num">${
        c.votes.toLocaleString("en-US")
      }</td><td class="num">${pct(c.percent)}</td><td class="bar-cell"></td></tr>`
    ).join("")
  }</tbody></table>`;
}

/** Source, its time, reporting, and when it was read. */
export function resultMeta(r: StoredResult): string {
  const c = r.count;
  const read = r.read_at === r.last_read
    ? `read ${readTime(r.read_at)}`
    : `first read ${readTime(r.read_at)}, unchanged at ${readTime(r.last_read)}`;
  return `<p class="meta">${link(c.source_url, c.source_name)}${
    c.as_of ? ` · ${esc(c.as_of)}` : ""
  }${c.reporting ? ` · ${esc(c.reporting)}` : ""} · ${read}</p>`;
}

/** Earlier counts of the same item, newest first, folded. */
export function resultHistory(history: readonly StoredResult[], names: readonly string[]): string {
  const older = history.slice(1);
  if (!older.length) return "";
  const line = (r: StoredResult) =>
    names.map((n, i) => {
      const at = r.order[i];
      const c = at === null || at === undefined ? null : r.count.choices[at];
      return `${esc(n)} ${c ? pct(c.percent) : "—"}`;
    }).join(" · ");
  return `<details class="fold"><summary>Earlier counts (${older.length})</summary><ul class="history">${
    older.map((r) =>
      `<li>${line(r)} <span class="meta">${r.count.as_of ? `${esc(r.count.as_of)} · ` : ""}read ${
        readTime(r.read_at)
      }</span></li>`
    ).join("")
  }</ul></details>`;
}

/** The results box for a race or measure page: the latest count, its standing, and its history. */
export function resultBox(
  history: readonly StoredResult[] | undefined,
  names: readonly string[],
  o: { picks?: readonly string[]; electionDate: string | null; now: Date; resultsHref: string },
): string {
  const latest = history?.[0];
  if (!latest) return "";
  return `<section class="results-box" id="results"><h2>Results</h2>
${resultTable(latest, names, o.picks)}
<p class="note">${
    esc(standing(latest, o.electionDate, o.now))
  } Listed in ballot order; no winner is named here.</p>
${resultMeta(latest)}
${resultHistory(history!, names)}
<p class="meta"><a href="${esc(o.resultsHref)}">Every result on your ballot</a></p></section>`;
}

/** The last check, in a line: when, how much matched, and what couldn't be read. */
export function checkLine(c: StoredCheck | null, total: number): string {
  if (!c) return "Results haven't been read for this ballot yet.";
  return `Last checked ${readTime(c.checked_at)}: ${c.matched} of ${total} items matched${
    c.errors.length
      ? `; ${c.errors.length} source${c.errors.length === 1 ? "" : "s"} couldn't be read (${
        c.errors.map((e) => `${e.source}: ${e.why}`).join("; ")
      })`
      : ""
  }.`;
}
