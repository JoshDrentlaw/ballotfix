/** HTML for the web app. Every page goes through render.ts's page(): no scripts, strict CSP. */

import { measuresOf } from "../dossier.ts";
import {
  candidateAnchors,
  coverageLine,
  type EntityLinks,
  esc,
  measureBody,
  measureTitle,
  page,
  raceBody,
  raceTitle,
  readableDate,
  stanceSummary,
  titleFor,
} from "../render.ts";
import { MAX_PRIORITIES, MAX_PRIORITIES_PER_LIST } from "../template.ts";
import { BALLOT_MEDIA_TYPES } from "../types.ts";
import type { BallotRecord, BallotStatus, ChoiceRecord, RunRecord, RunStatus } from "./store.ts";

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
  /** "What matters most to you": one issue per line. Optional. */
  priorities?: string;
}

export const DEFAULT_FORM: FormValues = {
  city: "",
  state: "CA",
  office: "Mayor",
  election: "2026-11-03",
  candidates: "",
  incumbent: "",
  priorities: "",
};

/** The optional "what matters most" field, shared by the race form and the ballot review. */
function prioritiesField(value: string, forBallot = false): string {
  return `<label>What matters most to you? <span class="hint">Optional. Up to ${MAX_PRIORITIES_PER_LIST} issues, one per line.${
    forBallot
      ? " These apply to everything you research from this ballot; each contest and measure can add its own below its name."
      : ""
  } Name a topic ("housing costs") or state your view ("protect abortion access", "oppose new sales taxes"). Where you state a view, each one is marked as conflicting with it or matching it when a cited source backs that up. Every candidate is checked against the same list.</span>
    <textarea name="priorities" maxlength="700">${esc(value)}</textarea></label>`;
}

/** One contest's or measure's own issues, on top of the ballot-wide ones. */
function itemPrioritiesField(key: string, value: string): string {
  return `<details${value ? " open" : ""}><summary>More issues for this one</summary>
  <label>Issues just for this one <span class="hint">One per line. Together with the ones for your whole ballot, up to ${MAX_PRIORITIES} in all.</span>
    <textarea name="priorities_${esc(key)}" maxlength="700">${esc(value)}</textarea></label>
</details>`;
}

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

/** "2026-10-27T06:38:00Z" -> "Oct 27, 2026, 6:38 AM UTC". */
function when(iso: string): string {
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

function progress(run: RunRecord): string {
  if (run.measure) {
    return run.status === "done"
      ? "Measure researched"
      : run.status === "queued" || run.status === "running"
      ? "Researching the measure"
      : "Measure not researched";
  }
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
            ? `${b.reading.contests.length} contests · ${b.reading.measures.length} measures · ${
              Object.keys(b.started).length
            } researched`
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
  <p class="sub">Reading takes about a minute and costs a few cents. Then you choose which contests and measures to research. The images are sent to Anthropic to be read and are not saved here; only the list of contests is kept. Leave out the return envelope, which has your signature. Marks on a filled-in ballot are ignored and never recorded.</p>
</form>
<h2>Or name one race</h2>`
    : "";

  const body = `<h1>Who's on your ballot?</h1>
<p class="sub">${
    o.canUpload ? "Upload your ballot, or name" : "Name"
  } a city and an office. Ballot Fix finds the candidates and builds a sourced dossier on each one: background, record, accomplishments, criticisms, money, endorsements, and platform.${
    o.canUpload
      ? " From your ballot it also researches measures: what they do, their history, who is behind each side, the money, and both sides' arguments."
      : ""
  } It never ranks or recommends anyone.</p>
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
  ${prioritiesField(v.priorities ?? "")}
  <button type="submit"${disabled}>Research this race</button>
  <p class="sub">Takes several minutes. Each candidate costs roughly one to two dollars of API use. You can leave this page and come back.</p>
</form>
${ballots}
<h2>Races</h2>
${runs}
${
    o.runs.some((r) => r.status === "done")
      ? `<p><a href="${base}/entities">Look up a name across finished research</a></p>`
      : ""
  }`;
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

/** The three views of a read ballot, as tabs at the top of each. */
type BallotTab = "research" | "researched" | "picks";

function ballotTabs(b: BallotRecord, items: readonly PickItem[], at: BallotTab, base: string) {
  const r = b.reading;
  const total = r ? r.contests.length + measuresOf(r).length : 0;
  const started = Object.keys(b.started).length;
  const decided = items.filter((x) => x.choice?.picks.length).length;
  const href = `${base}/ballots/${esc(b.id)}`;
  const tab = (t: BallotTab, path: string, label: string, count: string) =>
    `<a href="${href}${path}"${
      t === at ? ` aria-current="page"` : ""
    }>${label} <span class="count">${count}</span></a>`;
  return `<nav class="tabs" aria-label="This ballot">${
    tab("research", "", "To research", String(total - started))
  }${tab("researched", "/researched", "Researched", String(started))}${
    tab("picks", "/picks", "Picks", `${decided} of ${total}`)
  }</nav>`;
}

/** "Your pick: <strong>…</strong>", or "" when there's no pick yet. */
function yourPick(choice: ChoiceRecord | null): string {
  return choice?.picks.length ? `Your pick: <strong>${esc(choice.picks.join(", "))}</strong>` : "";
}

function leanLine(choice: ChoiceRecord | null): string {
  return `<span class="item-lean">${yourPick(choice) || "Undecided"}${
    choice?.notes ? " · has notes" : ""
  }</span>`;
}

export interface BallotPageOptions {
  canResearch: boolean;
  /** Races the queue will take right now. */
  available: number;
  base?: string;
  /** The posted review form, when re-rendering it with an error. */
  form?: FormData;
  error?: string;
  /** Every item with the voter's saved pick, for the tab counts and the pick inputs. */
  items?: PickItem[];
  /** The app keeps notes and picks, so they can be marked here before any research. */
  choices?: boolean;
  /** Just saved picks: say so. */
  saved?: boolean;
}

/**
 * The ballot page: reading progress, then whatever hasn't been researched yet,
 * one collapsed card per contest or measure, for review before any research.
 * Each card can also take a pick, for contests the voter already knows about.
 */
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
  const items = o.items ?? [];
  const byKey = new Map(items.map((x) => [x.key, x]));
  const posted = (name: string, fallback: string) => {
    const v = o.form?.get(name);
    return typeof v === "string" ? v : fallback;
  };
  const picked = new Set(o.form?.getAll("pick").map(String) ?? []);
  const pickedMeasures = new Set(o.form?.getAll("pick_measure").map(String) ?? []);

  /** The pick and notes for one item, posted with the rest of the form. */
  const choiceFields = (key: string, describe: Map<string, string> = new Map()) => {
    const it = byKey.get(key);
    if (!o.choices || !it) return "";
    const current = o.form
      ? o.form.getAll(`pick_${key}`).map(String).filter(Boolean)
      : it.choice?.picks ?? [];
    const inputs = it.options.length
      ? `<fieldset class="plain"><legend>Leaning toward${
        it.max > 1 ? ` (vote for up to ${it.max})` : ""
      }</legend><p class="hint">Optional and only for you; change it any time.</p>${
        choiceInputs(`pick_${key}`, it.options, it.max, current, describe)
      }</fieldset>`
      : "";
    return `${inputs}
<input type="hidden" name="seen_${esc(key)}" value="${esc(it.choice?.updated_at ?? "")}">
<label>Notes <textarea name="notes_${esc(key)}" maxlength="${MAX_NOTES}">${
      esc(posted(`notes_${key}`, it.choice?.notes ?? ""))
    }</textarea></label>`;
  };

  const contests = r.contests.map((c, i) => {
    if (b.started[String(i)]) return "";
    const where = [
      c.jurisdiction,
      c.vote_for ? `vote for ${c.vote_for}` : "",
      `${c.candidates.length} candidate${c.candidates.length === 1 ? "" : "s"}`,
    ].filter(Boolean).map(esc).join(" · ");
    const describe = new Map(
      c.candidates.map((p) => [
        p.name,
        [p.ballot_designation, p.incumbent ? "incumbent" : ""].filter(Boolean).join(" · "),
      ]),
    );
    const choice = choiceFields(String(i), describe);
    // Without pick inputs (no picks store), the names are listed on their own.
    const names = !c.candidates.length
      ? `<p class="gap">No candidate names could be read for this contest, so it can't be researched from here. You can still name it as one race on the home page.</p>`
      : o.choices && byKey.get(String(i))?.options.length
      ? ""
      : `<ol class="names">${
        c.candidates.map((p) =>
          `<li>${esc(p.name)}${
            p.ballot_designation ? ` <span class="desig">${esc(p.ballot_designation)}</span>` : ""
          }</li>`
        ).join("")
      }</ol>`;
    const fixes = c.candidates.length
      ? `${itemPrioritiesField(String(i), posted(`priorities_${i}`, ""))}
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
    const research = c.candidates.length
      ? `<label class="check research"><input type="checkbox" name="pick" value="${i}"${
        picked.has(String(i)) ? " checked" : ""
      }> Research this contest</label>`
      : "";
    return itemCard(
      String(i),
      esc(c.office),
      where,
      byKey.get(String(i))?.choice ?? null,
      `${names}${choice}${fixes}`,
      research,
      false,
    );
  }).join("");

  const measures = measuresOf(r);
  const measureItems = measures.map((m, i) => {
    if (b.started[`m${i}`]) return "";
    const retention = m.kind === "retention";
    const heading = retention ? m.person || m.label : m.label;
    const where = [m.jurisdiction, retention ? `retention · ${m.label}` : "measure"]
      .filter(Boolean).map(esc).join(" · ");
    const question = m.question
      ? `<details><summary>Ballot question</summary><p class="measure-q">${
        esc(m.question)
      }</p></details>`
      : "";
    // Open the fixes when something research needs wasn't read, so it's seen before submitting.
    const missing = !m.jurisdiction || (retention && !m.person);
    const fixes = `${itemPrioritiesField(`m${i}`, posted(`priorities_m${i}`, ""))}
<details${missing ? " open" : ""}><summary>Fix what was read</summary>
  ${
      retention
        ? `<label>Judge's name <input name="mperson_${i}" maxlength="100" value="${
          esc(posted(`mperson_${i}`, m.person.slice(0, 100)))
        }"></label>`
        : ""
    }
  <label>${
      retention ? "Office" : "Measure letter or number"
    } <input name="mlabel_${i}" maxlength="80" value="${
      esc(posted(`mlabel_${i}`, m.label.slice(0, 80)))
    }"></label>
  <label>Placed on the ballot by <span class="hint">City, county, district, or state, e.g. "City of Fontana".</span>
    <input name="mjur_${i}" maxlength="80" value="${
      esc(posted(`mjur_${i}`, m.jurisdiction.slice(0, 80)))
    }"></label>
</details>`;
    const research =
      `<label class="check research"><input type="checkbox" name="pick_measure" value="${i}"${
        pickedMeasures.has(String(i)) ? " checked" : ""
      }> ${retention ? "Research this judge" : "Research this measure"}</label>`;
    return itemCard(
      `m${i}`,
      esc(heading),
      where,
      byKey.get(`m${i}`)?.choice ?? null,
      `${question}${choiceFields(`m${i}`)}${fixes}`,
      research,
      missing,
    );
  }).join("");

  const canStart = r.contests.some((c, i) => c.candidates.length && !b.started[String(i)]) ||
    measures.some((_, i) => !b.started[`m${i}`]);
  const left = r.contests.some((_, i) => !b.started[String(i)]) ||
    measures.some((_, i) => !b.started[`m${i}`]);
  const started = Object.keys(b.started).length;
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const notes = r.notes
    ? `<details><summary>Reading notes</summary><p>${esc(r.notes)}</p></details>`
    : "";
  const check =
    `They were read by AI from your images and can be wrong. They're in the order your ballot prints them, contests first, then measures.${
      started ? ` The ${started} already started are under Researched.` : ""
    }`;
  // In full until research starts; after that it's been read, so it folds to one line.
  const banner = !left
    ? ""
    : started
    ? `<details class="banner"><summary><strong>Read by AI: check against your ballot</strong></summary><p>${check}</p>${notes}</details>`
    : `<div class="banner"><p><strong>Check these against your ballot before researching.</strong> ${check}</p>${notes}</div>`;
  const empty = r.contests.length || measures.length
    ? ""
    : `<p class="gap">No contests or measures were found on this ballot.</p>`;
  const done = !empty && !left
    ? `<p class="note">Everything on this ballot has been researched or is researching. See <a href="${base}/ballots/${
      esc(b.id)
    }/researched">Researched</a>, and mark your picks under <a href="${base}/ballots/${
      esc(b.id)
    }/picks">Picks</a>.</p>`
    : "";

  const election = posted("election", r.election_date ?? DEFAULT_FORM.election);
  const state = posted("state", r.state ?? DEFAULT_FORM.state);
  const ballotIssues = posted("priorities", "");
  // Open when the date or state wasn't read, so the default isn't used unnoticed.
  const issueCount = ballotIssues.split(/[\n;]/).filter((x) => x.trim()).length;
  const settings = canStart
    ? `<details class="settings"${
      r.election_date && r.state && !ballotIssues ? "" : " open"
    }><summary>Research settings <span class="item-meta">${esc(readableDate(election))} · ${
      esc(state)
    } · ${
      issueCount
        ? `${issueCount} issue${issueCount === 1 ? "" : "s"} for everything`
        : "no issues named"
    }</span></summary>
<div class="row">
  <label>Election date <input name="election" type="date" value="${esc(election)}"></label>
  <label>State <input name="state" maxlength="2" value="${esc(state)}"></label>
</div>
${prioritiesField(ballotIssues, true)}</details>`
    : "";
  const bar = left && (canStart || o.choices)
    ? `<div class="bar">
<div class="bar-buttons">
${
      canStart
        ? `<button class="go" type="submit"${
          o.canResearch ? "" : " disabled"
        }>Research checked</button>`
        : ""
    }
${
      o.choices
        ? `<button class="${
          canStart ? "secondary" : ""
        }" type="submit" formaction="${base}/ballots/${
          esc(b.id)
        }/picks?from=ballot" formnovalidate>Save picks</button>`
        : ""
    }
</div>
${
      canStart
        ? `<p class="sub">About $1 to $2 each · ${
          o.available ? `up to ${o.available} can start now` : "others are researching; try later"
        }</p>`
        : ""
    }
</div>`
    : "";

  const body = `<h1>${title}</h1>
<p class="sub">Read from ${b.pages} uploaded file${b.pages === 1 ? "" : "s"}${
    r.county ? ` · ${esc(r.county)}` : ""
  } · ${esc(when(b.created_at))}</p>
${ballotTabs(b, items, "research", base)}
${banner}
${o.saved ? `<p class="note" role="status">Saved.</p>` : ""}
${left ? "" : notes}${error}${empty}${done}
${
    left
      ? `<form class="stack ballot" method="post" action="${base}/ballots/${esc(b.id)}/research">
${settings}
${contests ? `<h2>Contests</h2><ol class="items">${contests}</ol>` : ""}
${
        measureItems
          ? `<h2>Measures and yes/no questions</h2>
<p class="sub">A measure gets what it would do, its history, who is behind each side, the money, its cost, and both sides' arguments. A judge on a retention question gets the same dossier as a candidate.</p>
<ol class="items">${measureItems}</ol>`
          : ""
      }
${bar}
</form>`
      : ""
  }`;
  return page(title, body, { nav: true, base });
}

/** One collapsed contest or measure: name, details, and the voter's pick at a glance. */
function itemCard(
  key: string,
  heading: string,
  where: string,
  choice: ChoiceRecord | null,
  inside: string,
  outside: string,
  open: boolean,
): string {
  return `<li class="item" id="item-${esc(key)}"><details${open ? " open" : ""}><summary>
<span class="item-title">${heading}</span><span class="item-meta">${where}</span>${
    leanLine(choice)
  }${outside ? `<span class="will" aria-hidden="true">Checked to research</span>` : ""}</summary>
<div class="item-body">${inside}</div></details>${outside}</li>`;
}

export interface ResearchedOptions {
  base?: string;
}

/**
 * Everything from a ballot that has research, in ballot order, with the quick
 * read for each candidate or measure: who conflicts with or matches the
 * voter's stated views. The same lines the race page's overview shows, side
 * by side so the whole ballot can be scanned without opening each one.
 */
export function researchedPage(b: BallotRecord, items: PickItem[], o: ResearchedOptions = {}) {
  const base = o.base ?? "";
  const title = "Researched";
  const done = items.filter((x) => x.run);
  const active = done.some((x) => x.run!.status === "queued" || x.run!.status === "running");
  const list = done.map((x) => {
    const run = x.run!;
    const href = `${base}/races/${esc(run.id)}`;
    let who = "";
    if (run.measure) {
      const d = run.measure_result;
      who = d?.status === "ok" ? stanceSummary(d.priorities, "measure") : "";
    } else if (run.race) {
      const anchors = candidateAnchors(run.race.candidates.map((d) => d.candidate.name));
      who = `<ul class="who">${
        run.race.candidates.map((d, i) => {
          const c = d.candidate;
          const desig = [c.ballot_designation ?? "", c.incumbent ? "Incumbent" : ""]
            .filter(Boolean).map(esc).join(" · ");
          const state = d.status === "pending"
            ? `<p class="cov cov-pending">Researching now…</p>`
            : d.status === "failed"
            ? `<p class="cov cov-fail">Research failed for this candidate.</p>`
            : `${stanceSummary(d.priorities, "candidate")}${coverageLine(d)}`;
          return `<li><a class="who-name" href="${href}#${anchors[i]}">${esc(c.name)}${
            desig ? ` <span class="desig">${desig}</span>` : ""
          }</a>${state}</li>`;
        }).join("")
      }</ul>`;
    }
    return `<li class="item" id="item-${esc(x.key)}"><div class="item-head"><h3><a href="${href}">${
      esc(x.heading)
    }</a></h3>${pill(run.status)}</div>
<p class="desig">${esc(x.detail)}</p>
<p class="item-lean"><a href="${href}#mine">${
      yourPick(x.choice) || `Undecided · <span class="link">set your pick</span>`
    }</a></p>
${who}
<div class="actions"><a class="button secondary" href="${href}">Open the research</a></div></li>`;
  }).join("");
  const asked = done.some((x) => (x.run!.priorities?.length ?? 0) > 0)
    ? `<p class="note">Under each name: which of your stated views its cited record conflicts with or matches, conflicts first. Within each contest every candidate was checked against the same issues, but the issues can differ from one contest or measure to the next. It is not a score or a recommendation; open the research and its sources before relying on it.</p>`
    : "";
  const body = `<h1>${title}</h1>
<p class="sub">From the ballot uploaded ${esc(when(b.created_at))}, in ballot order.</p>
${ballotTabs(b, items, "researched", base)}
${
    active
      ? `<p class="note" role="status">Some research is still running. This page refreshes itself every 10 seconds.</p>`
      : ""
  }
${
    done.length
      ? `${asked}<ol class="items">${list}</ol>`
      : `<p class="sub">Nothing from this ballot has been researched yet. Check what you want under <a href="${base}/ballots/${
        esc(b.id)
      }">To research</a>.</p>`
  }`;
  return page(title, body, { nav: true, base, ...(active ? { refreshSeconds: 10 } : {}) });
}

export const MAX_NOTES = 4000;

/**
 * What the voter can pick for a run: Yes or No for a measure or retention
 * question, else the candidates, up to the number the ballot says to vote for.
 */
export function choiceOptions(run: RunRecord): { options: string[]; max: number } {
  const listing = run.race?.listing;
  if (
    run.measure || listing?.contest_kind === "retention" ||
    run.candidate_source?.contest_kind === "retention"
  ) {
    return { options: ["Yes", "No"], max: 1 };
  }
  const names = (listing?.candidates ?? run.candidates ?? []).map((c) => c.name);
  return { options: names, max: Math.max(1, run.ballot?.vote_for ?? 1) };
}

function pickText(picks: readonly string[] | undefined): string {
  return picks?.length ? esc(picks.join(", ")) : `<span class="undecided">Undecided</span>`;
}

/**
 * What can be picked, plus any saved pick that is no longer listed (say, a
 * name corrected after it was picked), so saving the form never erases it.
 */
export function withSaved(options: readonly string[], saved: readonly string[] = []): string[] {
  return [...options, ...saved.filter((p) => !options.includes(p))];
}

/** Radio buttons (or checkboxes for vote-for-several) for a pick, with "Undecided". */
function choiceInputs(
  name: string,
  listed: readonly string[],
  max: number,
  current: readonly string[],
  describe: ReadonlyMap<string, string> = new Map(),
): string {
  const options = withSaved(listed, current);
  const picked = new Set(current);
  const text = (o: string) => {
    const d = describe.get(o);
    return `<span>${esc(o)}${d ? ` <span class="desig">${esc(d)}</span>` : ""}</span>`;
  };
  return max > 1
    ? options.map((o) =>
      `<label class="check"><input type="checkbox" name="${name}" value="${esc(o)}"${
        picked.has(o) ? " checked" : ""
      }> ${text(o)}</label>`
    ).join("")
    : [...options, ""].map((o) =>
      `<label class="check"><input type="radio" name="${name}" value="${esc(o)}"${
        (o ? picked.has(o) : picked.size === 0) ? " checked" : ""
      }> ${o ? text(o) : "Undecided"}</label>`
    ).join("");
}

/** The notes-and-pick form, for a researched run or a ballot item researched or not. */
function choiceForm(
  action: string,
  options: readonly string[],
  max: number,
  choice: ChoiceRecord | null,
  saved: boolean,
  sheet: string | null,
): string {
  const inputs = choiceInputs("pick", options, max, choice?.picks ?? []);
  return `${saved ? `<p class="note" role="status">Saved.</p>` : ""}
<form class="stack" method="post" action="${action}">
  ${
    options.length
      ? `<fieldset class="plain"><legend>Leaning toward${
        max > 1 ? ` (vote for up to ${max})` : ""
      }</legend>${inputs}</fieldset>`
      : ""
  }
  <label>Notes <span class="hint">For you, when you fill in your ballot.</span>
    <textarea name="notes" maxlength="${MAX_NOTES}">${esc(choice?.notes ?? "")}</textarea></label>
  <button type="submit">Save</button>
  <p class="sub">Saved on this server, never in downloaded pages. Anyone with the app's password can see it.${
    sheet ? ` All your picks are on <a href="${sheet}">your picks sheet</a>.` : ""
  }</p>
</form>`;
}

/**
 * The voter's notes and preliminary pick on a run's page. Hidden while
 * research runs, since the page refreshes itself and would throw away
 * anything half-typed.
 */
function choicePanel(
  run: RunRecord,
  choice: ChoiceRecord | null,
  active: boolean,
  base: string,
  saved: boolean,
): string {
  const head = `<section class="mine" id="mine"><h2>Your pick and notes</h2>`;
  if (active) {
    return `${head}<p class="sub">You can write notes and a preliminary pick here once research finishes.${
      choice ? ` So far: ${pickText(choice.picks)}.` : ""
    }</p></section>`;
  }
  const { options, max } = choiceOptions(run);
  return `${head}${
    choiceForm(
      `${base}/races/${esc(run.id)}/choice`,
      options,
      max,
      choice,
      saved,
      run.ballot ? `${base}/ballots/${esc(run.ballot.id)}/picks` : null,
    )
  }</section>`;
}

/** A neighbor in the walk through a ballot's researched items. */
export interface WalkStep {
  href: string;
  label: string;
}

/** Where a run sits among its ballot's researched items, in ballot order. */
export interface BallotWalk {
  /** The ballot's Researched tab. */
  href: string;
  /** 1-based, or 0 when this run isn't the ballot's current one for its item (an older run). */
  position: number;
  total: number;
  prev: WalkStep | null;
  next: WalkStep | null;
}

/** Previous / back to the ballot / next, so researched items can be read one after another. */
function walkNav(w: BallotWalk): string {
  const side = (s: WalkStep | null, cls: string, arrow: string) =>
    s
      ? `<a class="${cls}" href="${esc(s.href)}">${cls === "prev" ? `${arrow} ` : ""}<span>${
        esc(s.label)
      }</span>${cls === "next" ? ` ${arrow}` : ""}</a>`
      : `<span class="${cls}"></span>`;
  return `<nav class="walk" aria-label="Your ballot">${
    side(w.prev, "prev", "←")
  }<a class="mid" href="${esc(w.href)}">${
    w.position ? `${w.position} of ${w.total}` : "Your ballot"
  }</a>${side(w.next, "next", "→")}</nav>`;
}

export interface RunPageOptions {
  /** Started from a ballot: links to the ballot and its other researched items. */
  walk?: BallotWalk;
  /** The voter's saved notes and pick, when the app keeps them. */
  choice?: ChoiceRecord | null;
  /** Show the notes and pick panel. */
  choices?: boolean;
  /** Just saved: say so. */
  saved?: boolean;
  /** Links into entity pages, for a finished run the graph holds. */
  links?: EntityLinks;
}

export function runPage(
  run: RunRecord,
  canResearch: boolean,
  base = "",
  opts: RunPageOptions = {},
): string {
  const active = run.status === "queued" || run.status === "running";
  const rerun = canResearch && !active
    ? `<form class="inline" method="post" action="${base}/races/${
      esc(run.id)
    }/rerun"><button class="secondary" type="submit">Research again</button></form>`
    : "";
  const download = (run.measure ? run.measure_result : run.race) && run.status === "done"
    ? `<a class="button secondary" href="${base}/races/${esc(run.id)}/download">Download page</a>`
    : "";
  const walk = opts.walk ? walkNav(opts.walk) : "";
  const mine = `${
    opts.choices ? choicePanel(run, opts.choice ?? null, active, base, opts.saved ?? false) : ""
  }${walk}`;
  const jump = opts.choices ? `<a class="button" href="#mine">Your pick and notes</a>` : "";
  // Started from a ballot: the top bar leads back to it rather than to a new race.
  const back = opts.walk ? { href: opts.walk.href, label: "Your ballot" } : undefined;
  const actions = `${walk}${
    rerun || download || jump ? `<div class="actions">${jump}${download}${rerun}</div>` : ""
  }`;

  let status = "";
  if (active) {
    status = `<p class="note" role="status">${pill(run.status)} ${
      run.status === "queued"
        ? "Waiting for another race to finish."
        : run.measure
        ? "Researching this measure."
        : `${esc(progress(run))} done.`
    } This page refreshes itself every 10 seconds.</p>`;
  } else if (run.status === "failed" || run.status === "interrupted") {
    status = `<p class="error" role="alert">${pill(run.status)} ${
      esc(run.error ?? "Research stopped.")
    }</p>`;
  }

  const refresh = active ? { refreshSeconds: 10 } : {};
  if (run.measure) {
    if (!run.measure_result) {
      const title = measureTitle(run.measure);
      const body = `<h1>${esc(title)}</h1>
${status || `<p class="sub">No results were saved for this run.</p>`}
${actions}
${mine}`;
      return page(title, body, { nav: true, base, back, ...refresh });
    }
    return page(
      measureTitle(run.measure),
      measureBody(run.measure_result, {
        status,
        actions,
        mine,
        stopped: !active,
        links: opts.links,
      }),
      { nav: true, base, back, ...refresh },
    );
  }
  if (!run.race) {
    const title = titleFor(run.query);
    const body = `<h1>${esc(title)}</h1>
${status || `<p class="sub">No results were saved for this run.</p>`}
${
      active
        ? `<p class="sub">Finding who's on the ballot. Candidates appear here as soon as the list is found.</p>`
        : ""
    }
${actions}
${mine}`;
    return page(title, body, { nav: true, base, back, ...refresh });
  }
  return page(
    raceTitle(run.race),
    raceBody(run.race, { status, actions, mine, links: opts.links }),
    {
      nav: true,
      base,
      back,
      ...refresh,
    },
  );
}

/** One line of the picks sheet: a contest or measure, in ballot order. */
export interface PickItem {
  key: string;
  /** What can be picked: from the research run if there is one, else from the reading. */
  options: string[];
  max: number;
  heading: string;
  detail: string;
  run: RunRecord | null;
  choice: ChoiceRecord | null;
  /** Where this item's notes and pick are saved. */
  choiceId: string;
}

/**
 * Everything the voter has leaned toward, in ballot order, to fill in the
 * ballot from. One form, so every pick and note can be changed in place.
 */
export function picksPage(
  b: BallotRecord,
  items: PickItem[],
  base = "",
  o: { saved?: boolean; error?: string; form?: FormData } = {},
): string {
  const title = "Your picks";
  // Only what's been decided is listed; the rest is named at the bottom, so the
  // sheet never looks finished when it isn't.
  const decided = items.filter((x) => x.choice?.picks.length);
  const undecided = items.filter((x) => !x.choice?.picks.length);
  const posted = (name: string) => o.form?.getAll(name).map(String);
  const list = decided.map((x) => {
    const current = posted(`pick_${x.key}`)?.filter(Boolean) ?? x.choice?.picks ?? [];
    const notesValue = posted(`notes_${x.key}`)?.[0] ?? x.choice?.notes ?? "";
    const notes = x.choice?.notes ? `<p class="notes printonly">${esc(x.choice.notes)}</p>` : "";
    const research = x.run
      ? `${pill(x.run.status)} <a href="${base}/races/${esc(x.run.id)}">See the research</a>`
      : `Not researched${
        b.started[x.key]
          ? ""
          : ` · <a href="${base}/ballots/${esc(b.id)}#item-${esc(x.key)}">Research it</a>`
      }`;
    const inputs = x.options.length
      ? `<fieldset class="plain"><legend>Change pick${
        x.max > 1 ? ` (vote for up to ${x.max})` : ""
      }</legend>${choiceInputs(`pick_${x.key}`, x.options, x.max, current)}</fieldset>`
      : "";
    // Open the one with an error in it, and any with typing to keep. Browsers post
    // textarea newlines as CRLF, so compare the way parseChoice saves notes.
    const typed = notesValue.replace(/\r\n/g, "\n").trim();
    const open = o.form && (typed !== (x.choice?.notes ?? "") ||
      JSON.stringify(current) !== JSON.stringify(x.choice?.picks ?? []));
    return `<li id="item-${esc(x.key)}"><details${
      open ? " open" : ""
    }><summary><span class="item-title">${esc(x.heading)}</span><span class="item-meta">${
      esc(x.detail)
    }</span><span class="pick"><span class="label">Your pick:</span> ${
      pickText(x.choice?.picks)
    }</span>${x.choice?.notes ? `<span class="item-meta noprint">Has notes</span>` : ""}</summary>
<div class="noprint item-body">${inputs}
<input type="hidden" name="seen_${esc(x.key)}" value="${esc(x.choice?.updated_at ?? "")}">
<label>Notes <textarea name="notes_${esc(x.key)}" maxlength="${MAX_NOTES}">${
      esc(notesValue)
    }</textarea></label>
<p class="sub">${research}</p></div></details>${notes}</li>`;
  }).join("");
  /** Where an undecided item gets decided: its research page, or its card to research. */
  const decideAt = (x: PickItem) =>
    x.run
      ? `${base}/races/${esc(x.run.id)}#mine`
      : b.started[x.key]
      ? `${base}/ballots/${esc(b.id)}/researched`
      : `${base}/ballots/${esc(b.id)}#item-${esc(x.key)}`;
  const rest = undecided.length
    ? `<details class="settings undecided-list noprint"><summary>Still undecided (${undecided.length})</summary>
<ul class="who">${
      undecided.map((x) =>
        `<li><a class="who-name" href="${decideAt(x)}">${esc(x.heading)}${
          x.choice?.notes ? ` <span class="desig">has notes</span>` : ""
        }</a></li>`
      ).join("")
    }</ul></details>
<p class="printonly">Still undecided: ${undecided.map((x) => esc(x.heading)).join("; ")}</p>`
    : "";
  const body = `<h1>${title}</h1>
<p class="sub">From the ballot uploaded ${
    esc(when(b.created_at))
  } · ${decided.length} of ${items.length} decided. Contests in the order your ballot prints them, then measures in theirs; your ballot may mix the two.</p>
<div class="noprint">${ballotTabs(b, items, "picks", base)}</div>
<p class="note noprint">Only what you've picked is listed here; mark picks on any card under To research, or on a research page. Saved on this server. Check each against your actual ballot; the list was read by AI. Print this page or keep it open while you vote.</p>
${o.saved ? `<p class="note noprint" role="status">Saved.</p>` : ""}
${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ""}
${
    decided.length
      ? `<form method="post" action="${base}/ballots/${esc(b.id)}/picks">
<ol class="picks">${list}</ol>
<div class="bar noprint"><button type="submit">Save picks and notes</button></div>
</form>`
      : `<p class="sub">No picks yet.</p>`
  }
${rest}`;
  return page(title, body, { nav: true, base });
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
