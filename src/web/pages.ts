/** HTML for the web app. Every page goes through render.ts's page(): no scripts, strict CSP. */

import { esc, page, raceBody, raceTitle, readableDate, titleFor } from "../render.ts";
import type { RunRecord, RunStatus } from "./store.ts";

export interface FormValues {
  city: string;
  state: string;
  office: string;
  election: string;
  candidates: string;
  incumbent: string;
}

export const DEFAULT_FORM: FormValues = {
  city: "",
  state: "CA",
  office: "Mayor",
  election: "2026-11-03",
  candidates: "",
  incumbent: "",
};

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Waiting",
  running: "Researching",
  done: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
};

function pill(status: RunStatus): string {
  const cls = status === "queued" || status === "running" ? "running" : status;
  return `<span class="pill pill-${cls}">${STATUS_LABEL[status]}</span>`;
}

function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function progress(run: RunRecord): string {
  const cands = run.race?.candidates ?? [];
  if (!cands.length) return run.status === "done" ? "No candidates found" : "Finding the ballot";
  const done = cands.filter((c) => c.status !== "pending").length;
  return `${done} of ${cands.length} candidates`;
}

export interface HomeOptions {
  runs: RunRecord[];
  canResearch: boolean;
  values?: FormValues;
  error?: string;
}

export function homePage(o: HomeOptions): string {
  const v = o.values ?? DEFAULT_FORM;
  const disabled = o.canResearch ? "" : " disabled";
  const setup = o.canResearch
    ? ""
    : `<p class="error">Research is off because ANTHROPIC_API_KEY isn't set on the server. Saved races below still open.</p>`;
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const runs = o.runs.length
    ? `<ul class="runs">${
      o.runs.map((r) =>
        `<li><a href="/races/${esc(r.id)}"><strong>${esc(r.query.city)} ${
          esc(r.query.office)
        }</strong> ${pill(r.status)}<br><span class="when">${
          esc(readableDate(r.query.electionDate))
        } election · ${esc(progress(r))} · started ${esc(when(r.created_at))}</span></a></li>`
      ).join("")
    }</ul>`
    : `<p class="sub">No races researched yet.</p>`;

  const body = `<h1>Who's on your ballot?</h1>
<p class="sub">Name a city and an office. Ballot Fix finds the candidates and builds a sourced dossier on each one: background, record, accomplishments, criticisms, money, endorsements, and platform. It never ranks or recommends anyone.</p>
${setup}${error}
<form class="stack" id="new" method="post" action="/races">
  <div class="row">
    <label>City <input name="city" required maxlength="80" autocomplete="address-level2" value="${
    esc(v.city)
  }" placeholder="e.g. Fontana"></label>
    <label>State <input name="state" required maxlength="2" autocomplete="address-level1" value="${
    esc(v.state)
  }"></label>
  </div>
  <div class="row">
    <label>Office <input name="office" required maxlength="80" value="${
    esc(v.office)
  }" placeholder="e.g. Mayor"></label>
    <label>Election date <input name="election" type="date" required value="${
    esc(v.election)
  }"></label>
  </div>
  <details${v.candidates ? " open" : ""}><summary>Already know the candidates?</summary>
    <label>Candidates, one per line, in ballot order <span class="hint">Skips looking up the ballot. Leave empty to have it found for you.</span>
      <textarea name="candidates" maxlength="2000">${esc(v.candidates)}</textarea></label>
    <label>Current office holder, if running <span class="hint">Exactly as written above.</span>
      <input name="incumbent" maxlength="100" value="${esc(v.incumbent)}"></label>
  </details>
  <button type="submit"${disabled}>Research this race</button>
  <p class="sub">Takes several minutes. Each candidate costs roughly one to two dollars of API use. You can leave this page and come back.</p>
</form>
<h2>Races</h2>
${runs}`;
  return page("Ballot Fix", body, { nav: true });
}

export function runPage(run: RunRecord, canResearch: boolean): string {
  const active = run.status === "queued" || run.status === "running";
  const rerun = canResearch && !active
    ? `<form class="inline" method="post" action="/races/${
      esc(run.id)
    }/rerun"><button class="secondary" type="submit">Research again</button></form>`
    : "";
  const download = run.race && run.status === "done"
    ? `<a class="button" href="/races/${esc(run.id)}/download">Download page</a>`
    : "";
  const actions = rerun || download ? `<div class="actions">${download}${rerun}</div>` : "";

  let status = "";
  if (active) {
    status = `<p class="note" role="status">${pill(run.status)} ${
      run.status === "queued" ? "Waiting for another race to finish." : esc(progress(run))
    } done. This page refreshes itself every 10 seconds.</p>`;
  } else if (run.status === "failed" || run.status === "interrupted") {
    status = `<p class="error" role="alert">${pill(run.status)} ${
      esc(run.error ?? "Research stopped.")
    }</p>`;
  }

  const refresh = active ? { refreshSeconds: 10 } : {};
  if (!run.race) {
    const title = titleFor(run.query);
    const body = `<h1>${esc(title)}</h1>
${status || `<p class="sub">No results were saved for this run.</p>`}
${
      active
        ? `<p class="sub">Finding who's on the ballot. Candidates appear here as soon as the list is found.</p>`
        : ""
    }
${actions}`;
    return page(title, body, { nav: true, ...refresh });
  }
  return page(raceTitle(run.race), raceBody(run.race, { status, actions }), {
    nav: true,
    ...refresh,
  });
}

export function messagePage(title: string, message: string): string {
  return page(
    title,
    `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Back to Ballot Fix</a></p>`,
    {
      nav: true,
    },
  );
}
