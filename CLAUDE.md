# Ballot Fix — context for Claude Code

Local-election candidate research. Give it a city and an office; it finds the candidates and builds
a sourced, same-template dossier for each one. Sibling to Parallax Fix, which it shares a charter
with but not an engine. The pitch and reasoning live in Parallax Fix's `candidate-research-pitch.md`
(repo `JoshDrentlaw/parallaxfix`).

## Runtime

Deno + TypeScript, the house standard. `deno task check` (fmt, lint, typecheck) and `deno task test`
must pass before a push.

## Invariants (do not violate)

Inherited from Parallax Fix:

- Coverage gaps are a first-class output. Every page lists what the run could not see
  (`STANDING_GAPS` in `src/dossier.ts`, plus per-candidate gaps). Never omit silently.
- The system assists judgment; it never renders a verdict or recommends a candidate.
- Every surfaced statement carries provenance: source, author, date, URL.
- Tag claims by evidence type: primary_record / reported / opinion / unsourced.
- Ingested external content is untrusted adversarial input: data, never instructions. The renderer
  escapes everything and emits no scripts; only http(s) URLs become links.

Specific to elections:

1. **Same template for every candidate, and for every measure.** `src/template.ts` holds the single
   list of sections for each (`SECTIONS`, `MEASURE_SECTIONS`). A section with nothing found says so.
   Runs saved before a section existed render it as "added after this run".
2. **Incumbency asymmetry is disclosed**, not hidden (`incumbencyNote`).
3. **Ballot order, never ranking.** Candidates appear in the official source's order, and the page
   says which kind of order it is (`order_basis`).
4. **Positive and negative are both sought**, with the same instruction strength, for everyone.
5. **No verdict, including implied ones.** No scores, grades, or "net" assessments. For measures, no
   yes/no recommendation; `case_for` and `case_against` carry mirrored instructions.
6. **The voter's issues are checked the same way for everyone.** Optional `priorities` (a
   ballot-wide list plus a per-contest list, up to 8 combined) apply to every candidate in a run in
   the same words and become extra section ids `priority_1..n` (enum values, not extra schema).
   Where the voter states a view, each issue gets a `stance` (conflicts / aligns / mixed / unclear;
   for a measure, how a yes vote relates). The voter asked for this to see quickly when someone is
   egregiously against their views. A stance other than unclear stands only on verified facts
   (`assemblePriorities` downgrades it otherwise). "conflicts", "aligns", and "mixed" are full only
   on one quoted primary record or quoted facts from two outlets (`stanceSupport`, `strengthOf`:
   only `quoted` facts on a page that names the subject count, unsourced never, an outlet is one
   name and one page, a merged fact's sources each count); below that the researcher's stance is
   kept with `stance_strength: "thin"`, shown marked thin with its fact count and listed after full
   stances on the cards. Runs saved before have no strength and say their marks predate the
   threshold. Stances are never combined into an overall score or a recommendation.
7. **The voter's notes and picks are theirs.** `ChoiceStore` (its own `choices` table), apart from
   runs so a job's progress saves can't overwrite them. Never in downloads or a run's JSON. Ballot
   items use choice id `<ballotId>-<key>`, so a note made before research stays with it, and reruns
   keep it.

## Provenance check

A fact is shown as verified only if its URL is one the research session actually retrieved (a web
search result, a fetched page, or a citation). Anything else goes to a separate, collapsed
"unverified" list. This is the main defense against invented citations; don't weaken it.

On top of that, every verified fact (and a measure's YES/NO meanings) gets a quote check
(`checkFact` in `src/dossier.ts`). The research gives a short verbatim `quote` per fact (a plain
string in `FACT_SCHEMA`, never nullable: the schema is near the API's 16-union limit, and a test
counts). The adapter returns the text of every page the session opened (`opened_pages`, from
`web_fetch_tool_result` blocks), held in memory for the check and never saved. The quote is looked
for whole-word and in order after `plainText` (case, punctuation, quotes, dashes, whitespace,
markdown link targets), and the fact's `check` records a level: `quoted` (on a page it opened),
`not_found` (opened and read, not there: its own level, never folded into either neighbor), or
`seen` (search result only, a PDF not read yet, or no quote of `MIN_QUOTE_WORDS`+). The same check
flags (`missing_name`), never drops, a fact whose opened page lacks the candidate's surname or the
measure's label (or "Prop N", or its official title). The page shows the level as a chip and the
quote collapsed; runs saved before say "checked before quote checks existed". The graph stores the
level per claim (`check_level`), the merge step only groups facts at one level, and entity pages
show it. A found quote shows the page has those words, not that the statement reads them fairly.

## Architecture

- `src/types.ts`: core types and `ResearchPort`. No vendor imports.
- `src/research/anthropic.ts`: the model adapter. Claude with server-side `web_search` and
  `web_fetch`, JSON-schema output, `pause_turn` resumption, `fallbacks: "default"`. Searches run on
  Anthropic's side, so research needs only `api.anthropic.com`; the one other outbound host is
  `netfile.com`, for the NetFile primary-record adapter (approved for primary-record adapters;
  `deno.jsonc` and `SECURITY.md` grant it). Research defaults to `claude-opus-5-5`; merge to
  `claude-haiku-5-5` (no server-side fallback, so none is sent), context notes, finance, office
  powers, and the shared pass to `claude-sonnet-5-5`. Calls with web tools use top-level prompt
  caching (continuations resend the turn) and cap fetched text at `FETCH_MAX_CONTENT_TOKENS`;
  tool-less calls don't cache. Every call with web tools counts its search and fetch caps across
  `pause_turn` continuations (`remaining`): the API counts `max_uses` per request, and a fresh
  budget per pause would give a well-covered candidate more searches. A capped tool still allows one
  use per continuation, so a call makes at most its cap plus its continuation limit. Candidate and
  measure research save what they used as `effort` on the dossier, so effort parity can be checked;
  a failed call's error carries the same counts, and the failed dossier saves them. Every call logs
  one `[usage]` line (tokens, searches, an estimate at list prices via `PRICES`). It also implements
  `BallotReader` (`readBallot`): the voter's uploaded ballot photos/PDFs in, contests in printed
  order out, with no web tools.
- Shared race-level pass (roadmap item 9, `src/shared.ts`): once per race, after the candidate list
  and before any candidate, `runRace` makes one capped call (`SharedSourceFinder.findSharedSources`:
  `LOOKUP_EFFORT`, `BALLOTFIX_SHARED_MODEL` or `DEFAULT_SHARED_MODEL`, "off" skips it; CLI
  `--no-shared`; searches and fetches counted across continuations, `SHARED_MAX_*`) for pages that
  cover every candidate: the voter guide's statements, a questionnaire, forum write-ups, Voter's
  Edge. Only the race and the candidates' names are sent. A page is kept only if the call opened it,
  its text was readable, and that text, cut at `SHARED_PAGE_MAX_CHARS` as the candidates get it,
  names every candidate's surname (`assembleShared`); at most `MAX_SHARED_PAGES`. Everything else is
  saved as `left_out` with its reason. Kept pages go first in every candidate's prompt as one
  identical block with its own cache breakpoint (`sharedPrefix`), so the system prompt, tools, and
  that block are one cached prefix. They count as retrieved by each candidate's session, their whole
  text going to the quote check (`withShared`); search results the pass only saw are not added. The
  race saves `shared` (pages, left out, gaps, effort; never page text), shown collapsed after "At a
  glance" (`startedFromHtml`). A failed pass is recorded and every candidate starts without shared
  pages; a field of one gets no pass. The stability run finds it once and gives it to every run
  (`sharedPass`). Runs saved before have no `shared` and the page says nothing of it. The candidate
  `money` section no longer asks for contributions, contributors, or fundraising totals (the finance
  step reads those off the filings); it keeps independent expenditures and Form 700, and a race the
  finance step hasn't run for says so under each candidate's "Contributions on file".
- Ballot upload: images are held in memory for the one read call and never written to disk; only the
  `BallotReading` is saved (the `ballots` table). The reader must never report the voter's name,
  address, ballot id, or which choices are marked, and its schema has no field for them. The user
  reviews and corrects the reading before any research starts. Races started from it carry
  `candidate_source` with `order_basis: "official_ballot_order"`. A contest's place is the
  government the office belongs to, never a section heading (`ballotPlace` in `src/dossier.ts`:
  "City of Fontana Offices" is the City of Fontana; under a bare heading such as "School Offices"
  the office's title decides, statewide offices being the state's and an agency after a comma that
  agency's, then the ballot's county). The shared pass, office powers, NetFile, and context notes
  all look the place up by this name. Readings saved before it are read through it on the review
  form and when researching again; their saved data is unchanged.
- A read ballot has three tabs: To research (`/ballots/:id`, collapsed cards for unstarted items,
  each also taking a pick and notes; "Hide the N with a saved pick" is a CSS-only toggle that posts
  with the form and comes back as `?hide=decided`, never hides an item checked to research, and is
  off on an error page so what needs fixing stays in view; "Research checked" saves the page's picks
  and notes even when research can't start), Researched (`/researched`, each started item with its
  per-name stance lines, then a collapsed "Shared across this ballot": `ballotConnections` in
  `src/finance.ts`, every contributor or endorser tied to subjects of two or more items, by the same
  entity keys the race pages use, alphabetical, holders in ballot order, never counted up; same
  names in other places or close names are listed as possible matches, never matched; shown from two
  items up, with each item it couldn't fully compare named as a gap: research not done, finance not
  looked up or failed, no sourced notes), and Picks (`/picks`, only items with a pick; the rest are
  named in a "Still undecided" list linking to where to decide them). A page saving picks only
  touches the items it posted (`parseSheet`). Race pages started from a ballot get prev/next links
  through its researched items in ballot order (`walkFor`). The checked-to-research highlight and
  the count on the research button are CSS only (`:has()` and a CSS counter), so they need no
  script.
- Measures: the reader returns structured `BallotMeasure`s (`kind` measure or retention). Older
  saved readings hold bare strings; `measuresOf()` reads both. A measure run is a `RunRecord` with
  `measure` set and its result in `measure_result` (one session, `researchMeasure`). A retention
  question becomes a one-candidate race with `contest_kind: "retention"`. A measure's `vote_means`
  is one plain sourced statement each for a YES and a NO vote, from one shared instruction
  (`VOTE_MEANS_GUIDE`), shown above the effect section's facts; each gets the provenance check on
  its own (unverified goes to the unverified list), and runs saved before it say so. The graph
  stores them as effect-section claims, and the context step looks for names in them. Measure picks
  are keyed `m<index>` in `BallotRecord.started`.
- `src/dossier.ts`: validation and invariant enforcement. `src/race.ts`: orchestration, with
  `onUpdate` partial results (unfinished candidates have status "pending").
- `src/render.ts`: the shared page shell (`page`, strict CSP, all CSS) and race body. Used by both
  the app and the static export, so they can't drift apart.
- Web app (`deno task serve`, `src/serve.ts`): `src/web/server.ts` routes, `pages.ts` HTML,
  `jobs.ts` one-race-at-a-time queue (`DEFAULT_MAX_QUEUED` waiting, `BALLOTFIX_MAX_QUEUED`; no
  Redis: waiting runs are saved as "queued", and on start `RunStore.waiting()` puts them back in
  line (`JobRunner.resumeWaiting`, submission order), except when research is off or the run has
  waited over `MAX_RESUME_AGE_MS`; a run cut off mid-research is marked interrupted, not restarted,
  since rerunning pays again), `store.ts` runs/ballots/choices as JSON rows in one SQLite file
  (`data/ballotfix.db`, `db.ts`, Deno's built-in `node:sqlite`). `openStores()` imports the JSON
  files older versions wrote, once, and leaves them in place. No client JavaScript: forms post,
  running races use a meta refresh. POSTs must be same-origin (`Sec-Fetch-Site`, then `Origin`),
  because starting research spends money. "Research again" on a race or measure page opens a form
  (`againForm`, a details element) with the run's issues, up to `MAX_PRIORITIES` in one list, and
  its place, both editable (`parseAgain`; a post without the fields keeps the run's own). Only that
  item changes; the new run keeps the item's choice id, so the voter's pick and notes stay with it.
  Wherever issues are entered, `ISSUE_TIP` says what makes one findable.
- `BASE_PATH` (same convention as tower-expert's `main.ts`) lets the app sit behind a Caddy `handle`
  block that preserves the path prefix, e.g. `/ballotfix` on nucklehead. Every link, form action,
  and redirect is generated with it (`server.ts`, `pages.ts`, `render.ts`'s `page()`). Requests work
  with or without the prefix, so direct/local access is unaffected. Do **not** pair this with
  Caddy's `handle_path` (which strips the prefix) — the app has no concept of its incoming path
  being rewritten, so a stripped prefix and a preserved one must match.
- Knowledge graph (step 1 of the knowledge-base plan): `src/knowledge.ts` projects a finished
  dossier into entities (person, office, measure), claims with per-citation provenance, and
  relations (`candidate_for`, `holds`); `src/web/kb.ts` writes it to SQLite in the same transaction
  as the run's save, and answers queries. It is derived data: only `done` runs contribute,
  unverified facts stay `verified = 0`, and bumping `KNOWLEDGE_VERSION` rebuilds it from saved runs
  on start. People are keyed by state + jurisdiction + name, so same-named people elsewhere are
  never merged on name alone, and a person whose dossier has an `identity_note` is kept to that run.
  Indexing runs in a savepoint: a failure is logged and never undoes the run's save, and a rebuild
  skips a run it can't index rather than stopping startup. Indexing makes no model or network calls;
  later steps (context notes for names, campaign finance) add model calls and each has a cap.
- Merging duplicate claims (step 2, `src/merge.ts`): after a run is saved as done, `JobRunner` makes
  one capped call per run (`ClaimMerger.groupDuplicates`: no web tools, low effort, at most
  `MAX_MERGE_FACTS` facts, `BALLOTFIX_MERGE_MODEL` or `DEFAULT_MERGE_MODEL`, "off" skips it) and
  saves again. The model only returns groups of ids; `merge.ts` keeps a group only if it is all
  verified facts in one section of one candidate or measure, with one evidence type and one
  quote-check level, one fact per outlet, and event dates that agree (a year or month matches the
  days inside it). The earliest fact is kept in its own words and the rest go on it as `also`; the
  page says "Reported by N sources" and the graph stores it as one claim with N citations. A failed
  merge only logs: the run stays done, unmerged. The CLI does the same unless `--no-merge`.
- Context notes on names (step 3, `src/context.ts`): after the merge step, `JobRunner` makes one
  capped call per run (`ContextWriter.describeNames`: `LOOKUP_EFFORT` (medium),
  `BALLOTFIX_CONTEXT_MODEL` or `DEFAULT_CONTEXT_MODEL`, "off" skips it; CLI `--no-context`).
  Searches and fetches are counted across `pause_turn` continuations, and the call allows
  `CONTEXT_MAX_CONTINUATIONS`, so a run makes at most `CONTEXT_MAX_SEARCHES` + that many searches
  (likewise fetches). Names are found locally in verified facts (`findNames`, a heuristic: the page
  says some may be missed), and at most `MAX_CONTEXT_NAMES` are sent, in whole rounds only, one name
  per candidate per round (for a measure: case for, case against, the rest), so ballot order never
  buys an extra name. The request never labels whose facts a name came from, and candidates' names
  in quoted statements are replaced. Generic words ("Legislature", "Californians") and a measure's
  own sides ("Yes on ...", "No on ...") are not names. A note shows only if its URL was retrieved by
  that call, or it is reused: a name that already has a verified note from a finished run in the
  same place (`RunStore.knownNotes`, state + jurisdiction as the graph compares them) takes that
  note (`reused_from`: the run whose lookup retrieved its page, and when) and is not sent, so the
  cap goes to names nobody has described yet; the page says which notes came from an earlier lookup,
  and that names researched before are more likely to have one. Never from the run's own race or
  measure (same choice id), even via another run that reused it, so a rerun looks names up afresh. A
  failed call keeps reused notes. A note must be one short sentence with no evaluative word
  (`CHARACTERIZATIONS`). Every name found is accounted for on the page under "Names in these facts":
  not looked up (over the cap), no note needed (the model's "skip"), no sourced note, or an
  unverified note (collapsed, never next to the name). A failed call only logs, and is recorded on
  the dossier (`context.error`) so the page lists the names without notes. A shown note sits
  collapsed after the name's first mention in each fact (`attachNotes`, any case, shared with the
  graph). In the graph, a verified note makes a person or organization entity scoped by state +
  jurisdiction, with the note as a `context` claim, and every claim whose statement names it links
  to it with role `named`. The steps after a run is done (merge, context) run beside the race queue,
  not in it, so the next race doesn't wait on them.
- Campaign finance and shared connections (step 4, `src/finance.ts`): after the context step,
  `JobRunner` makes one capped call per run (`FinanceResearcher.findContributions`: `LOOKUP_EFFORT`,
  `BALLOTFIX_FINANCE_MODEL` or `DEFAULT_FINANCE_MODEL`, "off" skips it; CLI `--no-finance`), asking
  for itemized contributions (Form 460/497 on the city's or county's portal; for state committees,
  Cal-Access before `CARS_CUTOVER` and its replacement CARS from then on, by the lookup's date, not
  the election's, since Cal-Access's filings move to CARS) for every candidate in ballot order, a
  failed one too, or for a measure's support and oppose committees. Searches and fetches are counted
  across continuations (`FINANCE_MAX_SEARCHES`/`FETCHES` + `FINANCE_MAX_CONTINUATIONS`); max_tokens
  fails the call. Every subject gets the same share (`shareFor`: `MAX_FINANCE_CONTRIBUTIONS` split
  equally, at most `MAX_CONTRIBUTIONS_PER_SUBJECT`); verified rows over it are listed on the page,
  not kept. A row is shown only if its URL was retrieved by that call (else collapsed as unverified,
  never matched); fields stay as the record states them, and a row with a field too long or missing
  filer, contributor, or amount is dropped and counted, never cut. A subject with nothing gets a gap
  note; a failed call gives every subject one and records `finance.error`; a call that opened no
  page gives every subject `NOTHING_OPENED`, whatever it claims to have searched. Unreadable portals
  are `portal_gaps`, shown as coverage gaps. Matching (`contributorRef`): an organization by the
  named-entity rule exactly; an individual also needs the same identifying occupation and employer,
  else it is its own entity; an unknown type is never matched. Near misses ("Smith Development" /
  "... LLC", same-named retirees) are listed as "possibly the same, kept separate". Jurisdictions
  compare without a leading "City of" (`jurisdictionKey`). The race and measure pages show each
  subject's money the same way (alphabetical, totals only as the filing's own lines) and a collapsed
  "Shared connections" view for every pair (`raceConnections`, `measureConnections`): contributors,
  and endorsers via verified context notes in `SUPPORT_SECTIONS`. In the graph, a contribution is a
  `contributed_to` relation with the filing's words as detail and its page in `relation_citations`;
  a measure's two sides are `side` entities its case for/against are also about;
  `KnowledgeBase.sharedBetween` answers what two entities share.
- NetFile adapter (roadmap item 10, `src/netfile.ts`): a deterministic `FinanceResearcher` in front
  of the model lookup (`NetFileResearcher`, its `fallback`). Where a California place matches one
  NetFile agency (`agencyFor`: `BALLOTFIX_NETFILE_AGENCIES` set by hand, else by `agencyKey` in
  NetFile's agency list at `/public/campaign/agencies`, never a guess between two), it reads the
  agency's public transaction search (`/public/campaign/search/transaction/query`, by the agency's
  number, current filings only, so superseded amended rows are left out by NetFile) for the election
  year and the year before, plus its committee list (`/public/campaign/list/filer`), and keeps Form
  460 Schedules A and C and Form 497 Part 1 (search types 0, 1, 20; a 497 row repeated on a 460 is
  kept once), with no model in between. NetFile retired the per-year and per-filer CAL exports in
  2026; `fromSearch` puts search rows in the CAL field names the rest reads. The search has no
  entity code: a contributor with its own FPPC id is an organization, one with an occupation or
  employer an individual, anyone else unknown (never matched). Nothing about the race is sent.
  Committees are matched locally (`filerMatches`): a candidate's by first and last name, or by
  surname only when the name also states the election's year and the race's office ("Armendarez for
  City Treasurer 2026"), candidate-controlled when the type is stated, never a recall or opposing
  committee, one naming another office (`officeFits`), or one named for another year; a measure
  side's by the label plus "Yes on"/"No on" it, else words of that side only. A committee whose
  reports state another election's date is never matched, and an amended report's transactions are
  kept once, from the latest filing (`latestOnly`). A committee fitting two subjects goes to
  neither. Each unmatched subject gets a gap note saying how it was looked for. The place not on
  NetFile, no subject matched, or the export unreadable: the model looks up every subject (a portal
  gap says why when it was on NetFile), never a mix in one run. Rows keep the record's fields;
  `source_url` is the year's search URL (what counts as retrieved) and `filing_url` the filing's
  image. The result names its `source`, and only then `checkFinance` takes its larger share
  (`MAX_EXPORT_PER_SUBJECT`, the same for every subject). `BALLOTFIX_NETFILE=off` or CLI
  `--no-netfile` always uses the model; with the finance model off, the step is off. The page says
  which source the rows came from (`financeSource`).
- Office powers (roadmap item 8, `src/office.ts`): after the other steps, races only, `JobRunner`
  looks up what the race's office can do (`OfficeResearcher.findOfficePowers`: `LOOKUP_EFFORT`,
  `BALLOTFIX_OFFICE_MODEL` or `DEFAULT_OFFICE_MODEL`, "off" skips it; CLI `--no-powers`), with
  searches and fetches counted across continuations (`OFFICE_MAX_SEARCHES`/`FETCHES` +
  `OFFICE_MAX_CONTINUATIONS`). Nothing about the candidates is sent. It is told to fetch the charter
  or code section on the office's duties rather than cite search snippets, and to say who decides
  what voters often assume the office does (taxes, the budget, policing), so issues outside its say
  can be marked "outside" rather than "unclear". Its fixed sections (`OFFICE_SECTIONS`: what it
  decides, budget, seats, term) get the same provenance and quote check as a dossier
  (`assembleSections`), without the name check (a state law rightly never names the place). One
  lookup per office: `RunStore.knownOffice` reuses the newest verified, unfailed lookup from a
  finished race whose `officeKey` matches (state + jurisdiction + office with any district, seat, or
  area number left out) and whose lookup (`looked_up`) is under `OFFICE_REUSE_DAYS` old
  (`reused_from`, said on the page). Then each of the race's issues is marked inside, partly,
  outside, or unclear by a call without web tools that sees only the verified facts
  (`markIssueScopes`); a mark other than unclear stands only on a cited verified fact that isn't
  unsourced (`checkScopes`), and an issue worded as a reused lookup's keeps its mark without a call.
  The result is `RaceDossier.office`, once per race, the same for every candidate: never a stance,
  never combined with one. A failed lookup is recorded (`error`) and never reused; a failed marking
  call keeps the powers (`scope_error`). The graph doesn't hold it yet.
- Entity pages (step 5, `src/web/entities.ts`): read-only GET pages over the graph, no model or
  network calls. `/entities/:slug` (slug: a hash of the entity key, stable across rebuilds) shows
  one person, organization, office, measure, or side: facts about it in its kind's fixed sections
  (newest run first, every citation, evidence tag, and the run with when it was researched, marked
  when a newer finished run of the same race exists, `RunStore.newerDone`), facts that name it,
  contributions made and received (alphabetical, never summed), ballot relations, and the runs it
  comes from. Unverified claims stay collapsed. A candidate or side gets a collapsed "Shared with
  others in <place>": every other candidate and side in the same scope (`peersOf`), one block each,
  alphabetical, via `KnowledgeBase.between`. Near misses come from `nearMisses` in
  `src/knowledge.ts`, shared with the page view in `src/finance.ts`. `/entities` searches names in
  one place (`scope`), alphabetical. Keys mark kept-apart entities with `~run`/`~donor` parts
  (`keptApart`), which no normalized name can contain. App-served race and measure pages link to
  entity pages (`EntityLinks`, only entities their own run holds, `slugsOfRun`); downloads and CLI
  exports never do, and stay self-contained.
- Connections diagnostic (`deno task diagnose`, `src/diagnose.ts`): read-only report over
  `data/ballotfix.db`, no model or network calls. Per ballot: each item's scope and what its context
  and finance steps kept, and every name that recurs across subjects, with whether the pages can
  match it and, if not, why (different scope, entity rule, or no tie and the reason). Ties come from
  the same `raceParties`/`measureParties` the pages use.
- Stability run (`deno task stability`, `src/stability.ts`): reruns one race's research N times
  (default 3; no merge, context, or finance; the candidate list found once or given, so runs differ
  only in research) and reports per candidate and section how much the verified pages (normalized as
  the provenance check does, merged sources included) and facts overlap (Jaccard, mean and lowest
  over pairs of runs; facts match one to one by wording, `SAME_FACT`, a heuristic) and which
  sections read "Found" in some runs and not others. It spends money, so it prints an estimate
  (`TYPICAL_CANDIDATE_USAGE` at `PRICES`, an assumption, or `--per-candidate`) and stops unless
  given `--yes`; `--compare` reads saved runs and calls nothing. A failed candidate's run is left
  out of its overlap, never counted as finding nothing. Answer-key scoring (`deno task answer-key`,
  `src/answer_key.ts`, no calls): `sample` draws verified facts uniformly with a seed into a review
  sheet a person judges (supported / not_supported / wrong_person / unsure), `precision` scores it
  (unsure left out, a Wilson 95% interval, by quote-check level), and `recall` matches a key the
  owner writes for a past race (by a page it names, then by wording, within a section if given),
  listing each match to check; items naming a missing candidate or section, or a failed one, are
  left out of the rate. The code never judges a fact and no key ships with it.
- Icons: `static/icon.svg` is the source; `render.ts` embeds the same SVG (`ICON_SVG`, a test keeps
  them equal) as the favicon. `static/apple-touch-icon.png` is generated from it with
  `node examples/build_touch_icon.cjs` (rerun after changing the SVG) and served at
  `/apple-touch-icon.png` ahead of the password check.
- `src/main.ts`: CLI. `examples/demo_server.ts` (`deno task demo`): the app on placeholder research.

## Design system (`STYLES` in `src/render.ts`)

- Tokens by meaning, never reused across meanings: evidence type (`.ev` chips: filled for primary
  record, outlined for reported/opinion, dashed for unsourced; blues, purple, grey only), stance
  (`--stance-*`: red and green belong to stance alone; mixed is body text with a half-red,
  half-green rule), quote check (`.chk` chips: tinted and borderless, `--chk`, with `--chk-flag` for
  a quote not found and the "page doesn't mention" flag; `seen` is plain muted text), job status
  (`--ok` neutral, `--bad` amber), notices (`.banner.info` for the page's standing explanations,
  plain `.banner` warn colors only for something to act on), office scope (`.scope`: plain text and
  a dotted rule, never a stance color or a chip). Radii are `--r`/`--r-lg`; `--sticky` is the jump
  bar's height, for `scroll-margin-top`.
- Links: navigation in the accent, citations quiet (`.meta a`), entity pages dotted (`a.ent`).
- A race page reads overview first: cards, then "At a glance" (`glanceHtml`: the template down,
  candidates across in ballot order, each cell "Found" or "Nothing found" or a stance, linking to
  `sectionAnchor(candidateAnchor, section)`; never a fact count, which mostly measures press
  attention), then "What this office can do" (`officeHtml`: each issue's scope mark with what it
  cites, the office's sections collapsed; each issue row in the grid and each dossier's issue carry
  the same mark, `scopeMark`/`scopeLine`), then a sticky jump bar (`jumpHtml`) over the dossiers.
  The grid ends with "The research behind each" (`evidenceOf`): searches and pages opened (the
  dossier's `effort`, "Not recorded" on runs saved before it), outlets cited, primary records of
  facts kept, and the years its sources are dated. Every dossier and measure page has the same line
  under its name (`evidenceLine`), a failed one included: research errors carry their counts
  (`failureEffort`). Counts of effort and sources, never a score, never totaled across candidates.
- Shared connections (race, measure, and ballot) say each subject keeps at most `per_subject`
  contributions, so no overlap found means little.
- Long pages stay navigable without script: each dossier's name (`.dossier-name`) is sticky under
  the jump bar; a measure page gets the same jump bar (`measureJump`); app race and measure pages
  have a sticky pick dock (`dockNav`: pick plus prev/next in the ballot walk) that sits in the page
  just above the pick card so it comes to rest there, never in downloads; every page has a
  back-to-top link (`.to-top`, a plain `#top` anchor, faded in by a scroll timeline where
  supported). Long lists fold the same way for everyone: contributions (`details.fold`, count in
  view), each shared-connections pair (`details.pair`, `pairCount`), and the home page's one-race
  form once there is saved work (`?new` opens it). A failed candidate or measure says why once
  (`failedNote`); each section keeps its place saying "Not checked."
- In-page ids for candidates come from `candidateAnchors` (never `slug(name)` directly): unique per
  page, readable when the name is, any script kept. `slug` stays ASCII for run ids and file names.
- An empty section keeps its place in the template and says so, drawn compact (`.sec.empty`).
- Facts in a section are ordered by when they happened (`byWhen`): newest event date first, facts
  with none last, then by publication date. Never by importance. Each fact with an event date says
  "Happened ..." before its source; a section of two or more says its range (`whenRange`). Runs
  saved before event dates are ordered by publication date and the page says so.
- A fact shown in full under a voter's issue appears in its template section as a `refItem`: its
  words and every source of its own, plus a link up. Never drop a source from a fact anywhere.
- Contributions are tables, one per filing (`giftTables`), so filer, period, form, and source are
  said once. Fields stay as the record states them.
- Explanations live in collapsed "How to read this page" (`readingGuide`) and similar details, so
  findings come before boilerplate. Standing gaps stay on the page, collapsed under a count. The
  banner says each dossier is one research session (`ONE_SESSION`).
- Pages the research found but couldn't read (the shared pass's unreadable pages, often PDFs, and
  filing portals that need JavaScript or are scanned) are listed in plain view as "Pages to read
  yourself" (`readYourselfHtml`), each with the site it goes to and a line that public pages never
  ask for a sign-in or payment. A portal that asks for a login is not listed. Nothing on them is
  shown as a fact. PDF text extraction and JavaScript rendering are not planned.

## Verifying UI changes

There is no browser test harness in CI. For UI changes, run `deno task demo` and drive it with
Playwright against Chromium at `/opt/pw-browsers/chromium` at phone width (390px). Check for
horizontal overflow and walk the form, running, and finished states. The first such run found a bug
the unit tests missed: browsers can send `Origin: null` on the app's own form posts.

## Roadmap

`ROADMAP.md` holds the planned work in order, one PR per item, with the decisions already made. Read
it before starting a new item, and mark an item done there in the PR that finishes it.

## Phases

Phase 0 (this) is web research, for candidates and ballot measures, plus the first primary-record
adapter: Form 460 campaign finance from NetFile's export (`src/netfile.ts`). Later phases add more
behind `ResearchPort`/`FinanceResearcher`: city → ballot from the registrar, council minutes, then
budget/CIP extraction for a neighborhood-spending view.
