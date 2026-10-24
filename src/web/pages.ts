/**
 * HTML for the web app. Every page goes through render.ts's page() and its
 * strict CSP. Only the sign-in and account pages load a script (passkeys).
 */

import type { Credential } from "../auth/store.ts";
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
  /** Mount prefix (e.g. "/ballotfix") for generated links. Empty when served at root. */
  base?: string;
  /** Sign-in is on: show the Account link. */
  account?: boolean;
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

  const body = `<h1>Who's on your ballot?</h1>
<p class="sub">Name a city and an office. Ballot Fix finds the candidates and builds a sourced dossier on each one: background, record, accomplishments, criticisms, money, endorsements, and platform. It never ranks or recommends anyone.</p>
${setup}${error}
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
    <label>Current office holder, if running <span class="hint">Exactly as written above.</span>
      <input name="incumbent" maxlength="100" value="${esc(v.incumbent)}"></label>
  </details>
  <button type="submit"${disabled}>Research this race</button>
  <p class="sub">Takes several minutes. Each candidate costs roughly one to two dollars of API use. You can leave this page and come back.</p>
</form>
<h2>Races</h2>
${runs}`;
  return page("Ballot Fix", body, { nav: true, base, account: o.account });
}

export function runPage(run: RunRecord, canResearch: boolean, base = "", account = false): string {
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
    return page(title, body, { nav: true, base, account, ...refresh });
  }
  return page(raceTitle(run.race), raceBody(run.race, { status, actions }), {
    nav: true,
    base,
    account,
    ...refresh,
  });
}

export function messagePage(title: string, message: string, base = "", account = false): string {
  return page(
    title,
    `<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="${base}/">Back to Ballot Fix</a></p>`,
    {
      nav: true,
      base,
      account,
    },
  );
}

export interface LoginOptions {
  base: string;
  /** Where to go after signing in: an app path, already checked by the server. */
  next: string;
  /** Show the passkey button (the server has a secure BALLOTFIX_BASE_URL). */
  passkeys: boolean;
  error?: string;
  notice?: string;
}

export function loginPage(o: LoginOptions): string {
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const notice = o.notice ? `<p class="note" role="status">${esc(o.notice)}</p>` : "";
  // The button ships hidden; webauthn.js reveals it when the browser supports passkeys.
  const passkey = o.passkeys
    ? `<div class="stack-tight">
  <button type="button" hidden data-passkey-signin data-options="${o.base}/login/passkey/options" data-finish="${o.base}/login/passkey" data-next="${
      esc(o.next)
    }">Sign in with a passkey</button>
  <p class="error" role="alert" hidden data-passkey-status></p>
</div>`
    : "";
  const body = `<h1>Sign in</h1>
<p class="sub">Ballot Fix spends money on research, so it's private to whoever runs it.</p>
${error}${notice}${passkey}
<form class="stack" method="post" action="${o.base}/login">
  <input type="hidden" name="next" value="${esc(o.next)}">
  <label>Password <input type="password" name="password" required autocomplete="current-password"></label>
  <button type="submit"${o.passkeys ? ' class="secondary"' : ""}>Sign in with the password</button>
</form>`;
  return page("Sign in · Ballot Fix", body, {
    base: o.base,
    script: o.passkeys ? `${o.base}/static/webauthn.js` : undefined,
  });
}

/** Why passkeys are unavailable, or where they work, for the account page. */
export type PasskeySetup =
  | { state: "no-base-url" }
  | { state: "insecure"; baseUrl: string }
  | { state: "ready"; origin: string; elsewhere: string | null };

export interface AccountOptions {
  base: string;
  setup: PasskeySetup;
  credentials: readonly Credential[];
  sessions: number;
  error?: string;
  notice?: string;
}

function day(iso: string): string {
  return readableDate(iso.slice(0, 10));
}

export function accountPage(o: AccountOptions): string {
  const b = o.base;
  const error = o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : "";
  const notice = o.notice ? `<p class="note" role="status">${esc(o.notice)}</p>` : "";

  let setup = "";
  if (o.setup.state === "no-base-url") {
    setup =
      `<p class="error">Passkeys are off. Set <code>BALLOTFIX_BASE_URL</code> on the server to the
https:// address you open Ballot Fix at (just the origin, like <code>https://host.example.ts.net</code>),
then restart it.</p>`;
  } else if (o.setup.state === "insecure") {
    setup = `<p class="error">Passkeys are off. <code>BALLOTFIX_BASE_URL</code> is
<code>${esc(o.setup.baseUrl)}</code>, and browsers only allow passkeys over HTTPS (or on localhost).
Serve Ballot Fix over HTTPS and set it to that address.</p>`;
  } else if (o.setup.elsewhere) {
    setup = `<p class="error">Passkeys here belong to <code>${esc(o.setup.origin)}</code>, but this
page was opened at <code>${esc(o.setup.elsewhere)}</code>. Open the first address to register or use
one.</p>`;
  }

  const list = o.credentials.length
    ? `<ul class="runs">${
      o.credentials.map((c) => {
        const used = c.lastUsedAt ? `last used ${esc(day(c.lastUsedAt))}` : "not used yet";
        const kind = c.backedUp ? "synced" : "on one device only";
        return `<li class="card"><strong>${esc(c.label)}</strong><br><span class="sub">Added ${
          esc(day(c.createdAt))
        } · ${used} · ${kind}</span>
  <div class="actions">
    <form class="inline-field" method="post" action="${b}/account/passkeys/${esc(c.id)}/rename">
      <input name="label" maxlength="60" value="${esc(c.label)}" aria-label="Name for ${
          esc(c.label)
        }">
      <button class="secondary" type="submit">Rename</button>
    </form>
    <form class="inline" method="post" action="${b}/account/passkeys/${esc(c.id)}/delete">
      <button class="secondary" type="submit">Remove</button>
    </form>
  </div></li>`;
      }).join("")
    }</ul>`
    : `<p class="sub">No passkeys yet.</p>`;

  const ready = o.setup.state === "ready";
  // Hidden until webauthn.js confirms the browser can do this.
  const register = ready
    ? `<div class="stack-tight">
  <label hidden data-passkey-label>Name for this device <input maxlength="60" placeholder="e.g. Phone"></label>
  <button type="button" hidden data-passkey-register data-options="${b}/account/passkeys/options" data-finish="${b}/account/passkeys">Add a passkey on this device</button>
  <p class="error" role="alert" hidden data-passkey-register-status></p>
  <p class="sub" hidden data-passkey-unsupported>This browser doesn't support passkeys. The password still works.</p>
  <noscript><p class="sub">Adding a passkey needs JavaScript, which is off in this browser.</p></noscript>
</div>`
    : "";

  const body = `<h1>Account</h1>
${error}${notice}
<h2 class="section">Passkeys</h2>
<p class="sub">A passkey signs you in with your device's fingerprint, face, or PIN instead of the
password. The password keeps working either way, in case you lose a device.</p>
${setup}
${list}
${register}
<h2 class="section">Sessions</h2>
<p class="sub">Signed in on ${o.sessions} ${o.sessions === 1 ? "browser" : "browsers"}.</p>
<div class="actions">
  <form class="inline" method="post" action="${b}/logout"><button type="submit">Sign out</button></form>
  <form class="inline" method="post" action="${b}/account/sign-out-everywhere"><button class="secondary" type="submit">Sign out everywhere</button></form>
</div>`;
  return page("Account · Ballot Fix", body, {
    nav: true,
    base: b,
    account: true,
    script: ready ? `${b}/static/webauthn.js` : undefined,
  });
}
