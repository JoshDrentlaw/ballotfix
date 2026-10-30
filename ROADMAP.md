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

## 3. Quote check and three verification levels — done

Branch `feature/focused-feynman-f4fej8`. Decisions made in the PR:

- "Opened, quote not found" is its own level, `not_found`, so the levels are `quoted`, `not_found`,
  and `seen` (plus unverified, unchanged). Folding it into `seen` would hide a mismatch the voter
  should look at. `seen` covers search-result-only pages, PDFs (opened, not read yet), and quotes
  that are empty or under `MIN_QUOTE_WORDS` (5) words; the chip says which (`checkLabel`).
- Normalizing is broader than planned: every run of non-letters/digits is one space (so quotes,
  dashes, punctuation, and markdown emphasis all compare equal), and markdown link targets are
  dropped. Matching is whole-word. An ellipsis-joined quote must have every piece, in order.
- A quote over `MAX_QUOTE_LENGTH` (600) isn't kept (never cut); the fact is then `seen`.
- The name check keeps `missing_name` on the fact; the graph stores only the level.
- Older runs: one note in the page's banner ("checked before quote checks existed"), not a chip per
  fact. `KNOWLEDGE_VERSION` 8 and a migration add `claims.check_level`.

Follow-ups:

- Not yet run against the live API. The schema gained one plain string per fact (no new unions; a
  test counts them), but the API has also rejected this schema for "compiled grammar too large"
  before. Run one real race and one measure before relying on it, and watch how often quotes come
  back `not_found` (if often, look at the fetched text's format before blaming the model).
- PDF text extraction, so PDFs can reach `quoted`.
- Context notes and finance rows have no quote check yet.
- The name check is a heuristic: a one-letter or very common surname passes easily, and a measure
  page that uses only a nickname ("the parks tax") is flagged.

Original plan:

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

## 4. At a glance: labels and an evidence row — done

Branch `feature/serene-sagan-6e2oss`. Decisions made in the PR:

- Cells say "Found" (a link) or "Nothing found" in plain view; the money row says "None found" or
  "Not looked up". No numbers are left in the section cells.
- The evidence row is five rows at the bottom of the grid ("The research behind each"): searches,
  pages opened, outlets cited (distinct publishers by `publisherKey`, merged sources included),
  primary records as "N of M facts kept", and the years the sources are dated. A fact shown under a
  voter's issue and in its section counts once. Because a race with one candidate has no grid, every
  dossier and the measure page also get one line under the name with the same counts and the full
  dates (`evidenceLine`).
- Item 1's follow-up is done here: the adapter attaches `effort` to the error a research call
  throws, and `failedCandidate`/`placeholderMeasure` save it (`failureEffort`). A failed candidate's
  searches and pages show in the grid; its fact rows say research failed.
- The cap line on shared connections uses the run's own `per_subject` (race and measure pages) and
  the largest one among the ballot's items (`BallotConnections.per_subject`, ballot page), shown
  only where filings were read.

Original plan:

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

## 5. Stance threshold — done

Branch `feature/relaxed-edison-i2lg7e`. Decisions made in the PR:

- "Thin" is a flag beside the stance, `stance_strength: "full" | "thin"` on every conflicts, aligns,
  or mixed stance, not a new `Stance` value, so older runs' data stays valid. Absent means the run
  predates the threshold: those stances read as before (full), and the "How your issues are marked"
  note opens and says they may be thin.
- Full: one primary record or facts from two outlets (distinct by `publisherKey`'s name rule and by
  page, so one page under two names is one outlet), counting only `quoted` facts on a page that
  names the subject (no `missing_name`), never unsourced ones. A merged fact's other sources count
  as their own outlets, so the merge step can't change a stance's strength. Opinion facts count
  toward two outlets; a stance resting only on opinion still says so in its basis.
- Thin stances show the stance color with ", thin", a dashed rule, and what they rest on ("1 fact,
  none with its quote found on its page"); on cards they come after every full stance, each issue
  with its fact count; the grid says "Conflicts, thin". No new prompt text: the rule is enforced
  after research, the same for everyone.

Original plan:

`assemblePriorities` (`src/dossier.ts` ~line 153) lets one opinion-only fact produce "conflicts".

- "conflicts" or "aligns" needs two verified facts from different outlets, or one primary record.
  Below that, the stance is shown as thin: the model's stance, marked thin, with the fact count, and
  sorted after full stances on the cards. Decide in the PR whether "thin" is a new `Stance` value or
  a flag beside it (a flag keeps older runs' data valid).
- After item 3, count only `quoted` facts toward the threshold.
- "mixed" follows the same rule.
- Update invariant 6 in CLAUDE.md (approved).

## 6. Event dates — done

Branch `feature/sweet-feynman-rq1q5m`. Decisions made in the PR:

- `event_date` is a plain string in `FACT_SCHEMA` ("" when unknown; the union count is unchanged and
  the test still counts). The prompt says it is when what the statement describes happened, not the
  page's date, and to leave it empty for something ongoing. Only an ISO day, month, or year is kept
  (anything else can't be ordered, so it reads as unknown). Facts built now always have the field
  (null when unknown); absent means the run predates event dates.
- Order is newest first: by event date, then facts without one by publication date, then as the
  research gave them. Partial dates sort as text, so a day comes before the month it is in. The same
  rule for every candidate and measure, and for the voter's issues; vote meanings aren't sorted.
- Each fact with an event date says "Happened ..." before its source. A section with two or more
  facts says "Events <from> to <to>" and how many have no event date; one fact's date is already on
  it. A range inside one year or month is said once.
- Older runs: ordered by publication date, each section says "Sources published ...", and the page's
  banner says once that the run predates event dates.
- Merge step: a group's known event dates must agree (a year or month matches the days inside it;
  the date most of the group shares wins, so one outlier doesn't block the rest), so a merged fact
  is one event. A merged fact without its own event date uses its other sources' most specific one.

Follow-ups:

- The knowledge graph doesn't store event dates yet, so entity pages still order by run. Add a
  column (and bump `KNOWLEDGE_VERSION`) when entity pages need a timeline.
- Not yet run against the live API: watch how often the model gives the publication date as the
  event date.

Original plan:

`published` is the page's date, not the event's.

- Add `event_date` (plain string, "" when unknown; same schema-size constraint as `quote`).
- Sort facts within a section by event date (unknown last, then by published), and show each
  section's date range. Older runs fall back to `published` and say so.

## 7. Stability run — done

Branch `ccr-79f4f0bc-5rxe3r`. Decisions made in the PR:

- Only research reruns: merge, context, and finance don't change which pages a run kept, and
  skipping them keeps the cost to the research calls. The candidate list is found once (or given)
  and reused, so runs differ only in research. Runs are saved to `out/stability/` with the report.
- Overlap is Jaccard, mean and lowest over every pair of runs, per section and per candidate (pages
  in any section). Pages compare normalized (`normalizeUrl`), merged sources included. Facts match
  one to one by wording (`SAME_FACT`, 60% of words alike by Dice), since two runs rarely word a fact
  the same way: a heuristic, so the JSON lists the counts and the text says to check it. A section
  empty in both runs is agreement and has no overlap figure. The report also lists sections that
  read "Found" in some runs and "Nothing found" in others, since that is what the grid would show
  differently. A failed candidate's run is left out of its overlap and counted as missing.
- The estimate is an assumption (`TYPICAL_CANDIDATE_USAGE`, about $1 a candidate on the default
  model), labeled as such; `--per-candidate` replaces it. Without `--yes` nothing is spent.
  `--compare` reads saved runs (CLI output or `/races/:id.json`) at no cost.
- Answer key: `sample` draws facts uniformly at random (seeded) rather than equally per candidate,
  so precision estimates the research as a whole; it is reported overall and by quote-check level,
  never per candidate. Judgments are the reviewer's (supported, not supported, wrong person,
  unsure); unsure is left out. Each rate carries a 95% Wilson interval, because a sample of 25 says
  little. Recall matches the owner's key by a page it names, then by wording, within a section when
  the key gives one, and lists every match for a person to check. No key or judgments ship.

Follow-ups:

- Not yet run against the live API (it spends money; nothing was run from the build session). Run
  one race three times and record the overlap here. If it is low, add a line to the page saying a
  dossier is one research session and another may find different sources, and consider showing the
  union across runs on entity pages (the graph already holds every done run).
- The owner writes a key for a past race and judges a sample; record precision and recall here.
- Measures aren't covered by the stability run yet.

Original plan:

A `deno task stability` script (spends money, so it only runs when asked; print an estimate first
and require a flag to proceed): rerun one race N times (default 3) and report, per section, how much
the verified URLs and facts overlap. If overlap is low, the page wording should say a dossier is one
sample, and entity pages could show the union across runs (the graph already holds them).

Also build the scoring half of an answer-key check (precision on a random sample of verified facts,
recall against a list the owner writes for a past race). The owner supplies the key; don't invent
one.

## 8. Office powers — done

Branch `feature/bold-babbage-ulso2g`. Decisions made in the PR:

- Two calls, not one: the lookup (web tools, capped like the context call: 6 searches, 4 fetches, 3
  continuations) is cached per office, and the voter's issues are marked by a separate call with no
  web tools that sees only the lookup's verified facts. So a reused lookup still gets this run's
  issues marked, and marks rest on the same facts whether the lookup is fresh or reused. An issue
  worded as one the reused lookup already marked keeps that mark with no call.
- "Cached" is reuse from finished runs, as context notes are (`RunStore.knownOffice`), not a new
  table: the result lives on the race (`RaceDossier.office`), so downloads carry it. The key is the
  state, the jurisdiction, and the office with any district, seat, trustee area, or office number
  left out, so every council district shares one lookup. Reused only when it didn't fail, found at
  least one verified fact, and is under a year old (`OFFICE_REUSE_DAYS`; budgets change yearly). A
  rerun of the same race reuses it too.
- Four marks: inside, partly (shares the say or decides part of it), outside, unclear. A mark other
  than unclear needs a cited verified fact that isn't unsourced; anything else is unclear. The mark
  is about the issue as a topic, never the voter's view, and is styled apart from stances (plain
  text and a dotted rule).
- Shown once per race ("What this office can do", after the grid), under each issue's name in the
  grid, and under each issue in every dossier, in the same words. Races only: measures have no
  office.

Follow-ups:

- Not yet run against the live API. Check that the lookup finds the charter or code rather than a
  generic explainer, and how often marks come back unclear.
- The knowledge graph doesn't hold office facts yet, so the office's entity page doesn't show them.
- Retention races look up the judge's office the same way; a court's "budget" is often not on
  record, which reads as a gap.

Original plan:

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
