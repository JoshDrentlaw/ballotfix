/** HTML for the web app. Every page goes through render.ts's page(): no scripts, strict CSP. */

import { esc, page, raceBody, raceTitle, readableDate, titleFor } from "../render.ts";
import { BALLOT_MEDIA_TYPES } from "../types.ts";
import type { BallotRecord, BallotStatus, RunRecord, RunStatus } from "./store.ts";

/** Upload limits. Claude takes up to 10 MB of base64 per image and 32 MB per request. */
export const MAX_BALLOT_FILES = 8;
export const MAX_BALLOT_FILE_BYTES = 7 * 1024 * 1024;
export const MAX_BALLOT_TOTAL_BYTES = 22 * 1024 * 1024;

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
  ballots?: BallotRecord[];
  /** Show the ballot upload form. Only when the app has a ballot reader. */
  canUpload?: boolean;
  /** Error from the ballot upload form. */
  ballotError?: string;
  /** Mount prefix (e.g. "/ballotfix") for generated links. Empty when served at root. */
  base?: string;
}

export function homePage(o: HomeOptions): string {
  const v = o.values ?? DEFAULT_FORM;
  const base = o.base ?? "";
  const disabled = o.canResearch ? "" : " disabled";
  const setup = o.canResearch
    ? ""
    : `<p class="error">Research is off because ANTHROPIC_API_KEY isn't set on the server. Saved races below still open.</p>`;
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const runs = o.runs.length
    ? `<ul class="runs">${
      o.runs.map((r) =>
        `<li><a href="${base}/races/${esc(r.id)}"><strong>${esc(r.query.city)} ${
          esc(r.query.office)
        }</strong> ${pill(r.status)}<br><span class="when">${
          esc(readableDate(r.query.electionDate))
        } election · ${esc(progress(r))} · started ${esc(when(r.created_at))}</span></a></li>`
      ).join("")
    }</ul>`
    : `<p class="sub">No races researched yet.</p>`;

  const ballotError = o.ballotError
    ? `<p class="error" role="alert">${esc(o.ballotError)}</p>`
    : "";
  const ballots = o.ballots?.length
    ? `<h2>Your ballots</h2><ul class="runs">${
      o.ballots.map((b) =>
        `<li><a href="${base}/ballots/${esc(b.id)}"><strong>Ballot uploaded ${
          esc(when(b.created_at))
        }</strong> ${ballotPill(b.status)}<br><span class="when">${
          b.reading
            ? `${b.reading.contests.length} contests · ${Object.keys(b.started).length} researched`
            : `${b.pages} file${b.pages === 1 ? "" : "s"}`
        }</span></a></li>`
      ).join("")
    }</ul>`
    : "";

  // Only offered when the app was given a ballot reader; otherwise /ballots is a 404.
  const upload = o.canUpload
    ? `<h2 id="upload">Start from your ballot</h2>
${ballotError}
<form class="stack" method="post" action="${base}/ballots" enctype="multipart/form-data">
  <label>Photos or PDF of your ballot <span class="hint">Your sample ballot or mail-in ballot. Take one photo per side, flat and in good light, or upload the PDF from your county's website. Up to ${MAX_BALLOT_FILES} files.</span>
    <input type="file" name="pages" required multiple accept="${
      BALLOT_MEDIA_TYPES.join(",")
    }"></label>
  <button type="submit"${disabled}>Read my ballot</button>
  <p class="sub">Reading takes about a minute and costs a few cents. Then you choose which contests to research. The images are sent to Anthropic to be read and are not saved here; only the list of contests is kept. Leave out the return envelope, which has your signature. Marks on a filled-in ballot are ignored and never recorded.</p>
</form>
<h2>Or name one race</h2>`
    : "";

  const body = `<h1>Who's on your ballot?</h1>
<p class="sub">${
    o.canUpload ? "Upload your ballot, or name" : "Name"
  } a city and an office. Ballot Fix finds the candidates and builds a sourced dossier on each one: background, record, accomplishments, criticisms, money, endorsements, and platform. It never ranks or recommends anyone.</p>
${setup}
${upload}
${error}
<form class="stack" id="new" method="post" action="${base}/races">
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
    <label>Current office holders, if running <span class="hint">Exactly as written above. Separate several with semicolons.</span>
      <input name="incumbent" maxlength="300" value="${esc(v.incumbent)}"></label>
  </details>
  <button type="submit"${disabled}>Research this race</button>
  <p class="sub">Takes several minutes. Each candidate costs roughly one to two dollars of API use. You can leave this page and come back.</p>
</form>
${ballots}
<h2>Races</h2>
${runs}`;
  return page("Ballot Fix", body, { nav: true, base });
}

const BALLOT_LABEL: Record<BallotStatus, [string, string]> = {
  reading: ["Reading", "running"],
  read: ["Read", "done"],
  failed: ["Failed", "failed"],
  interrupted: ["Interrupted", "interrupted"],
};

function ballotPill(status: BallotStatus): string {
  const [label, cls] = BALLOT_LABEL[status];
  return `<span class="pill pill-${cls}">${label}</span>`;
}

export interface BallotPageOptions {
  canResearch: boolean;
  /** Races the queue will take right now. */
  available: number;
  base?: string;
  /** The posted review form, when re-rendering it with an error. */
  form?: FormData;
  error?: string;
}

/** The ballot page: reading progress, then the contests found, for review before any research. */
export function ballotPage(b: BallotRecord, o: BallotPageOptions): string {
  const base = o.base ?? "";
  const title = "Your ballot";
  if (b.status === "reading") {
    return page(
      title,
      `<h1>${title}</h1>
<p class="note" role="status">${ballotPill(b.status)} Reading ${b.pages} file${
        b.pages === 1 ? "" : "s"
      }. This usually takes under a minute. This page refreshes itself every 5 seconds.</p>`,
      { nav: true, base, refreshSeconds: 5 },
    );
  }
  if (!b.reading) {
    return page(
      title,
      `<h1>${title}</h1>
<p class="error" role="alert">${ballotPill(b.status)} ${
        esc(b.error ?? "This ballot couldn't be read.")
      }</p>
<p><a class="button" href="${base}/#upload">Upload again</a></p>`,
      { nav: true, base },
    );
  }

  const r = b.reading;
  const posted = (name: string, fallback: string) => {
    const v = o.form?.get(name);
    return typeof v === "string" ? v : fallback;
  };
  const picked = new Set(o.form?.getAll("pick").map(String) ?? []);

  const contests = r.contests.map((c, i) => {
    const runId = b.started[String(i)];
    const where = [
      c.jurisdiction,
      c.vote_for ? `vote for ${c.vote_for}` : "",
      `${c.candidates.length} candidate${c.candidates.length === 1 ? "" : "s"}`,
    ].filter(Boolean).map(esc).join(" · ");
    const names = c.candidates.length
      ? `<ol class="names">${
        c.candidates.map((p) =>
          `<li>${esc(p.name)}${
            p.ballot_designation ? ` <span class="desig">${esc(p.ballot_designation)}</span>` : ""
          }</li>`
        ).join("")
      }</ol>`
      : `<p class="gap">No candidate names could be read for this contest.</p>`;
    const choose = runId
      ? `<p><a href="${base}/races/${esc(runId)}">Research started: view this race</a></p>`
      : c.candidates.length
      ? `<label class="check"><input type="checkbox" name="pick" value="${i}"${
        picked.has(String(i)) ? " checked" : ""
      }> Research this contest</label>
<details><summary>Fix what was read</summary>
  <label>Office <input name="office_${i}" maxlength="80" value="${
        esc(posted(`office_${i}`, c.office.slice(0, 80)))
      }"></label>
  <label>City or district <input name="city_${i}" maxlength="80" value="${
        esc(posted(`city_${i}`, c.jurisdiction.slice(0, 80)))
      }"></label>
  <label>Candidates, one per line, in ballot order <span class="hint">If you change this list, the race says its order was entered by you rather than taken from the ballot.</span>
    <textarea name="candidates_${i}" maxlength="2000">${
        esc(posted(`candidates_${i}`, c.candidates.map((p) => p.name).join("\n")))
      }</textarea></label>
  <label>Current office holders, if running <span class="hint">Exactly as written above. Separate several with semicolons.</span>
    <input name="incumbent_${i}" maxlength="300" value="${
        esc(
          posted(
            `incumbent_${i}`,
            c.candidates.filter((p) => p.incumbent).map((p) => p.name).join("; "),
          ),
        )
      }"></label>
</details>`
      : "";
    return `<li class="contest"><h3>${
      esc(c.office)
    }</h3><p class="desig">${where}</p>${names}${choose}</li>`;
  }).join("");

  const anyLeft = r.contests.some((c, i) => c.candidates.length && !b.started[String(i)]);
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const notes = r.notes
    ? `<p class="note"><strong>Reading notes.</strong> ${esc(r.notes)}</p>`
    : "";
  const measures = r.measures.length
    ? `<h2>Not researched here</h2>
<p class="sub">Ballot Fix researches candidates, not measures or yes/no retention questions. These were on your ballot:</p>
<ul class="gaps">${r.measures.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`
    : "";
  const empty = r.contests.length
    ? ""
    : `<p class="gap">No contests between candidates were found on this ballot.</p>`;
  const submit = anyLeft
    ? `<div class="row">
  <label>Election date <input name="election" type="date" required value="${
      esc(posted("election", r.election_date ?? DEFAULT_FORM.election))
    }"></label>
  <label>State <input name="state" required maxlength="2" value="${
      esc(posted("state", r.state ?? DEFAULT_FORM.state))
    }"></label>
</div>
<button type="submit"${o.canResearch ? "" : " disabled"}>Research selected contests</button>
<p class="sub">Each candidate costs roughly one to two dollars of API use. ${
      o.available
        ? `Up to ${o.available} contest${o.available === 1 ? "" : "s"} can be started right now.`
        : "Other races are researching right now; try again when one finishes."
    }</p>`
    : "";

  const body = `<h1>${title}</h1>
<p class="sub">Read from ${b.pages} uploaded file${b.pages === 1 ? "" : "s"}${
    r.county ? ` · ${esc(r.county)}` : ""
  } · ${esc(when(b.created_at))}</p>
<div class="banner"><p><strong>Check these against your ballot before researching.</strong> They were read by AI from your images and can be wrong. Contests are in the order your ballot prints them, and candidates in the order printed under each.</p></div>
${notes}${error}${empty}
<form class="stack" method="post" action="${base}/ballots/${esc(b.id)}/research">
<ol class="contests">${contests}</ol>
${submit}
</form>
${measures}`;
  return page(title, body, { nav: true, base });
}

export function runPage(run: RunRecord, canResearch: boolean, base = ""): string {
  const active = run.status === "queued" || run.status === "running";
  const rerun = canResearch && !active
    ? `<form class="inline" method="post" action="${base}/races/${
      esc(run.id)
    }/rerun"><button class="secondary" type="submit">Research again</button></form>`
    : "";
  const download = run.race && run.status === "done"
    ? `<a class="button" href="${base}/races/${esc(run.id)}/download">Download page</a>`
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
    return page(title, body, { nav: true, base, ...refresh });
  }
  return page(raceTitle(run.race), raceBody(run.race, { status, actions }), {
    nav: true,
    base,
    ...refresh,
  });
}

export function messagePage(title: string, message: string, base = ""): string {
  return page(
    title,
    `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="${base}/">Back to Ballot Fix</a></p>`,
    {
      nav: true,
      base,
    },
  );
}
