# Roadmap

Work planned from the review "Ballot Fix review: accuracy, efficiency, and a more realistic picture"
(Oct 2026, commit `60960f1`). The review's theme: in a few places the page claims more than the code
enforces. Each item below is one PR, in this order unless noted. Mark an item done here in the PR
that finishes it, with a link.

Every PR: `deno task check` and `deno task test` pass; UI changes are walked in `deno task demo` at
390px (see CLAUDE.md, "Verifying UI changes"); CLAUDE.md is updated where an invariant or the
architecture changes; runs saved before a change still render, saying what they predate.

## Decisions already made (by the owner, Oct 30 2026)

- **At a glance:** replace the per-cell fact counts with "found" / "nothing found" labels, and add
  the evidence row (item 4). Update the CLAUDE.md design-system line that says the grid shows
  counts.
- **Stance threshold:** tightening the stance rule is approved. Update invariant 6 in CLAUDE.md to
  match (item 5).
- **NetFile adapter:** calling hosts other than `api.anthropic.com` is fine for primary-record
  adapters. Update the "only needs `api.anthropic.com`" line in CLAUDE.md when it lands (item 10).

## 1. Search caps hold across continuations — done

Branch `feature/ecstatic-dirac-i4hajf`. Candidate, measure, and ballot-lookup research now count
their caps across continuations, as the context and finance steps already did (so the old
`acrossTurns` option is gone: every call with web tools does this), so a pause no longer starts a
fresh `max_uses` budget. `remaining()` floors at 1 (the API rejects 0 while the tool is in the
history), so a call makes at most its cap plus `MAX_CONTINUATIONS` (8). Each candidate and measure
dossier saves `effort: { searches, fetches }` (the tool uses the caps count), absent on older runs.
Nothing renders it yet; item 4 does.

Follow-ups (from review of PR #21):

- A failed candidate or measure saves no `effort`, though a call that runs out of continuations is
  the costliest case. Do this with item 4: let the research errors carry the counts and have
  `failedCandidate`/`placeholderMeasure` save them, so the evidence row can show them.
- A lower continuation limit for research (like `CONTEXT_MAX_CONTINUATIONS`), if usage logs show
  research often reaching the cap and then pausing several more times.

## 2. Cal-Access → CARS (small, time-sensitive) — done

Branch `ccr-e25e74f0-3joiam`. Checked Oct 30, 2026 (by search; sos.ca.gov itself couldn't be fetched
from the build session): the Secretary of State's go-live page says only "post-election, November
2026", and its reports and briefings have said Nov 11, 16, and 26. No CARS address was found. So
`CARS_CUTOVER` is the earliest of those (2026-11-11), the CARS instruction still allows Cal-Access
if CARS isn't open yet, and the prompt names no CARS address (it says to find it from sos.ca.gov).
The source goes by the lookup's date, not the election date as first planned: once Cal-Access is
gone, an earlier election's filings are only in CARS. Local filings keep Forms 460/497/410; for CARS
filings the prompt says to copy the record's own form name rather than assume the old numbers. The
measure `money` ask says "or the state or local equivalent" rather than naming CARS, since the
template is the same before and after the cutover. Update `CARS_CUTOVER` when the Secretary of State
names the day.

Original plan:

The review says Cal-Access is replaced by CARS on Nov 11, 2026, after which the old site is gone and
state filings drop the old FPPC form numbers. **Check the date and the new site's address against
the Secretary of State's page first** (sos.ca.gov, "CAL-ACCESS Replacement System (CARS) Go-Live
Updates"); this wasn't verified when the roadmap was written.

- `FINANCE_SYSTEM` (`src/research/anthropic.ts`, ~line 651) hard-codes `cal-access.sos.ca.gov` and
  Form 460/497/410 vocabulary. Make the state-committee source depend on the election date:
  Cal-Access before the cutover, CARS after (one constant for the date, tested both sides).
- Measure template `money` text (`src/template.ts`) names Forms 410/460/497; say "or the CARS
  equivalent" rather than dropping the local form numbers, which local filers keep using.
- Update the finance paragraph in CLAUDE.md.

## 3. Quote check and three verification levels

Today a fact is "verified" if its URL appears anywhere the session retrieved, including every
search-result URL (`retrievedUrls`, `src/research/anthropic.ts` ~line 825), where the model saw only
a title and snippet. Nothing checks that the page says what the fact says, or is about the same
person.

- Add `quote` (short verbatim excerpt) to `FACT_SCHEMA`. It must be a plain `string`, not nullable:
  the schema is near the API's 16 union-typed-parameter limit (see the comment above `FACT_SCHEMA`).
  Empty string means none. Same for `vote_means` entries.
- Keep fetched page text from `web_fetch_tool_result` blocks for the duration of the run (the block
  is `content: { type: "web_fetch_result", url, content: <document block> }`; plain text arrives as
  text, PDFs as base64). Return it from `#run` alongside `urls`; never save it to the database.
- Check each quote against its page after normalizing whitespace, quotes/dashes, and case. Give each
  fact a level, saved on `Fact`:
  - `quoted`: the quote was found on a page the session opened;
  - `seen`: the URL was opened but the quote wasn't found or was empty, or was only in search
    results;
  - unverified stays as now (the URL wasn't retrieved), in the collapsed list. Decide in the PR
    whether "opened, quote not found" gets its own level; don't fold it into `quoted`.
- Name check: flag a fact whose opened page doesn't contain the candidate's surname (or, for a
  measure, its label/letter). Show the flag; don't drop the fact.
- PDFs: first pass is "opened, quote not checked". Local PDF text extraction is a follow-up.
- Render: show the level on each fact (new chip style, distinct from evidence-type chips per the
  design-system rule on tokens), and the quote collapsed under the fact. Runs saved before this say
  "checked before quote checks existed".
- Knowledge graph: store the level on claims (bump `KNOWLEDGE_VERSION`). Merge step: only group
  facts at the same level. Entity pages show the level.
- Update the "Provenance check" section of CLAUDE.md. Don't weaken the existing check.

## 4. At a glance: labels and an evidence row

`glanceHtml` (`src/render.ts` ~line 869) shows fact counts per cell; "Criticisms: 9 | 1" mostly
measures press attention.

- Per cell: "found" or "nothing found" (decided), still linking to the section. Stance cells stay as
  they are.
- One evidence row per candidate (and the measure page's equivalent): searches and pages opened
  (from item 1's `effort`), distinct outlets, share of primary records, date range covered. Counts
  of effort, never a score. "Not recorded" for runs saved before `effort`.
- Shared connections (race and ballot level): add a line that each subject keeps at most
  `MAX_CONTRIBUTIONS_PER_SUBJECT` rows, so finding no overlap means little.
- Update the "At a glance" line in CLAUDE.md's design system section.

## 5. Stance threshold

`assemblePriorities` (`src/dossier.ts` ~line 153) lets one opinion-only fact produce "conflicts".

- "conflicts" or "aligns" needs two verified facts from different outlets, or one primary record.
  Below that, the stance is shown as thin: the model's stance, marked thin, with the fact count, and
  sorted after full stances on the cards. Decide in the PR whether "thin" is a new `Stance` value or
  a flag beside it (a flag keeps older runs' data valid).
- After item 3, count only `quoted` facts toward the threshold.
- "mixed" follows the same rule.
- Update invariant 6 in CLAUDE.md (approved).

## 6. Event dates

`published` is the page's date, not the event's.

- Add `event_date` (plain string, "" when unknown; same schema-size constraint as `quote`).
- Sort facts within a section by event date (unknown last, then by published), and show each
  section's date range. Older runs fall back to `published` and say so.

## 7. Stability run

A `deno task stability` script (spends money, so it only runs when asked; print an estimate first
and require a flag to proceed): rerun one race N times (default 3) and report, per section, how much
the verified URLs and facts overlap. If overlap is low, the page wording should say a dossier is one
sample, and entity pages could show the union across runs (the graph already holds them).

Also build the scoring half of an answer-key check (precision on a random sample of verified facts,
recall against a list the owner writes for a past race). The owner supplies the key; don't invent
one.

## 8. Office powers

One cached model call per office type (keyed by state + jurisdiction + office): what the office
decides, budget, seats, term, with sources and the provenance check. Each voter issue is marked
inside or outside the office's authority, so "unclear" on an issue the office has no say in doesn't
read as evasive. The same note for every candidate in the race. Cap and "off" switch like the other
steps (`BALLOTFIX_OFFICE_MODEL`).

## 9. Shared race-level pass

- One search pass per race for pages that cover every candidate: the county voter guide's
  statements, the local paper's Q&A, forum write-ups, Voter's Edge. Put those pages first in every
  candidate's prompt, in an identical prefix so prompt caching applies, so every candidate starts
  from the same sources.
- Drop contributor hunting from the candidate `money` section text in `src/template.ts`; the finance
  step does it, and two readings of one filing can disagree. Keep independent expenditures and
  Form 700. Runs saved before keep what they have.

## 10. NetFile adapter

A deterministic primary-record adapter behind `ResearchPort`/`FinanceResearcher` for NetFile's
public transaction exports, removing the transcription risk and the per-subject row cap where a city
uses NetFile. Fall back to the model lookup elsewhere. Rows keep the export's own fields; provenance
is the export URL and the filing. Update CLAUDE.md's runtime note about outbound hosts (approved).
