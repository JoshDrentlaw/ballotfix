# Ballot Fix

Who's on your local ballot, and what have they actually done? Give Ballot Fix a city and an office,
or a photo of your ballot. It finds the candidates and measures and builds a sourced dossier for
each one, all on the same template. Every fact links to its source and is tagged by the kind of
evidence behind it.

It never ranks or recommends anyone. Candidates appear in ballot order, every one gets the same
sections and the same research effort, and every page says what the run couldn't see.

## Quick start

```sh
cp .env.example .env        # then put your Anthropic API key in it
deno task serve             # open http://127.0.0.1:8787
```

To try the app without an API key or any cost, run `deno task demo` (port 8788). It is the real app
with placeholder research.

## Getting research onto the page

There are two ways in.

**Research one race.** On the home page, enter a city, state, office, and election date and tap
**Research this race**. Claude finds the official candidate list (county registrar, city clerk) and
the page says which kind of source set the order. If you already know the candidates, open **Already
know the candidates?** and list them one per line in ballot order.

**Start from your ballot.** Upload photos of your sample or mail-in ballot (one per side), or the
sample ballot PDF from your county. Claude reads the contests off it in about a minute, for a few
cents. You check the reading, fix any misread names, and tick what to research. Each contest becomes
a race whose candidate order is labeled as coming from your ballot (or as entered by you, if you
changed the list).

- Images are sent to Anthropic to be read and are never written to disk. Only the list of contests
  is saved.
- The reader is told never to transcribe your name, address, ballot id, or barcodes, and to ignore
  any marks on a filled-in ballot. Still, leave the return envelope out of the photo.
- JPEG, PNG, WebP, or PDF; up to 8 files, 7 MB each, 22 MB in total. If an iPhone photo arrives as
  HEIC, the app says how to fix it.

A race page fills in as each candidate finishes and refreshes itself, so you can leave and come
back. Finished races stay listed on the home page.

## What a finished race page shows

From top to bottom:

1. **A standing notice** that the page ranks no one, with **What this run couldn't see** (standing
   gaps, collapsed under a count) and a collapsed **How to read this page**.
2. **Candidate cards**, in ballot order, labeled with the kind of order (official, from your ballot,
   or entered by you), plus a note on incumbency (an incumbent has a record in office to search; a
   challenger may not).
3. **At a glance**: a grid with the template's sections down the side and the candidates across.
   Each cell is a fact count (or, for your issues, a stance) that links to that section of that
   candidate's dossier. Counts only, never totals or scores.
4. **A sticky jump bar** to move between candidates while you read.
5. **A dossier per candidate**, always these sections, in this order: Who they are; Record in this
   office; Accomplishments; Criticisms and controversies; Money and interests; Endorsements and
   affiliations; Stated platform; Community impact and local coverage. A section with nothing found
   stays in its place and says so. Each dossier ends with its own gaps and:
   - **Contributions on file**: itemized contributions read off campaign finance filings (Form
     460/497 on the city's or county's portal, Cal-Access for state committees). One table per
     filing, so filer, period, form, and source are said once; rows are alphabetical by contributor
     and stay exactly as the record states them. The app never sums them.
6. **Campaign finance this run couldn't read**: portals that couldn't be opened.
7. **Shared connections** (collapsed): for every pair of candidates, contributors they share and
   endorsers they share. Names that might be the same but aren't proven to be ("Smith Development"
   and "Smith Development LLC") are listed as "possibly the same, kept separate".
8. **Names in these facts**: short, sourced, one-sentence notes on people and organizations named in
   the facts (who a donor or endorser is). Each note sits collapsed after the name's first mention
   in a fact. Every name found is accounted for here: noted, no note needed, not looked up (over the
   cap), or left unverified.

Facts reported by several outlets are merged into one, marked "Reported by N sources", with every
source kept.

Each fact carries its source, author, date, and URL, and an evidence tag: **primary record**,
**reported**, **opinion**, or **unsourced**. A fact is shown as verified only if its URL is one the
research actually opened. Anything else goes to a collapsed "unverified" list, as a lead rather than
a finding.

Buttons at the top: **Download page** (one self-contained HTML file to share) and **Research
again**.

### Measures and judges

Measures, propositions, and judicial retention questions read off a ballot can be ticked the same
way.

- A **measure** gets one page with fixed sections: What a yes or no vote does; History; Who is for
  and against it; Money; Cost and fiscal effect; The case for, as supporters make it; The case
  against, as opponents make it (mirrored instructions); Endorsements and local coverage. The first
  section starts with what a **YES** vote means and what a **NO** vote means, a plain sourced
  sentence or two each, side by side, written with the same instruction (from the official "what
  your vote means" text or the impartial analysis). Its contributions are read for the support and
  oppose committees, with shared connections between the two sides.
- A **judge on a retention question** gets a candidate dossier as a one-person race, and the page
  explains there is no opponent to compare with.

### What matters most to you (optional)

On the race form and the ballot review you can list up to five issues, one per line. On a ballot,
that list covers everything you research, and each contest or measure can add its own (up to eight
in all). Each issue becomes an extra section, shown first, for every candidate and measure, asked in
the same words for everyone in the contest.

Name a topic ("housing costs") or state a view ("protect abortion access"). For a stated view, each
candidate is marked **conflicts with your view**, **matches your view**, **mixed**, or **not enough
on record**, with a one-line basis, and the cards show conflicts first. A conflict or match only
stands when a source the research actually opened backs it. There is never an overall score or a
recommendation. For a measure, the mark is about what a yes vote would do.

## Your ballot: three tabs

A read ballot has three tabs:

- **To research**: every contest and measure not started yet, as collapsed cards. Tick the ones to
  research (the button counts them), and you can already record a pick and notes here.
- **Researched**: everything started, with each name's stance lines for your issues, conflicts
  first. Race pages started from a ballot get previous/next links through these in ballot order.
- **Picks**: only items you've picked, in ballot order, with a "Still undecided" list linking to
  where to decide the rest. It prints as a clean cheat sheet for filling in your ballot.

On a finished race or measure page, **Your notes and pick** holds a preliminary choice (radio
buttons, checkboxes for vote-for-two contests, Yes/No for measures and judges) and free-form notes.
Notes and picks are stored apart from research, kept when you research again, and never included in
downloaded pages.

## Looking up a name across your research

Once any race is finished, the home page links to **Look up a name across finished research**
(`/entities`). Race and measure pages served by the app also link names to their own pages (dotted
links). An entity page shows one person, organization, office, measure, or side of a measure:

- facts about it, in its kind's fixed sections, newest run first, each with its sources and the run
  it came from (marked when a newer finished run of the same race exists);
- facts in other dossiers that name it;
- contributions it made and received (listed, never summed);
- which races or measures it is on, and the runs it comes from;
- for a candidate or side, a collapsed **Shared with others in \<place\>**: what it shares with
  every other candidate and side researched in the same place.

People are only matched within the same state and jurisdiction, so same-named people elsewhere are
never merged on name alone. Downloaded pages don't link to entity pages and stay self-contained.

## Races researched before a feature existed

Some features are added while a race is being researched, so a race saved before they existed
doesn't have them. **Research again** on that race's page adds them. Your ballot doesn't need to be
uploaded again: the new run keeps the ballot link, ballot order, your issues, and your notes and
picks.

| Feature                                          | Saved races                     |
| ------------------------------------------------ | ------------------------------- |
| At a glance, jump bar, page layout, entity pages | Shown right away                |
| Merged duplicate facts                           | Needs Research again            |
| Notes on names in the facts                      | Needs Research again            |
| Contributions on file, Shared connections        | Needs Research again            |
| The YES / NO summary on a measure                | Needs Research again            |
| A template section added later                   | Shown as "added after this run" |

Without the finance step, a page's Shared connections compares endorsements only and says why.

## How a run works

1. **Ballot.** The official candidate list is found (or taken from your checked ballot), with the
   kind of order recorded.
2. **Research.** One session per candidate or measure, a few at a time, with server-side web search
   (up to 15) and page fetch (up to 10; at most 25,000 tokens of text per page, while PDFs come in
   whole). Output is JSON constrained to the fixed template.
3. **Provenance check.** Facts count as verified only if their URL was actually retrieved in that
   session.
4. **After the run is done**, three capped follow-up calls, each saved as it finishes and each
   allowed to fail without undoing the run:
   - **Merge**: groups duplicate verified facts (Claude Haiku 5.5, no web tools, low effort, up to
     240 facts).
   - **Context notes**: short sourced notes on up to 30 names, shared evenly across candidates
     (Claude Sonnet 5.5, medium effort, about 10 searches and 5 fetches).
   - **Campaign finance**: itemized contributions for every candidate or both sides of a measure
     (Claude Sonnet 5.5, medium effort, about 12 searches and 10 fetches, up to 120 rows shared
     equally, at most 20 per candidate). Rows over the share are counted on the page, not kept.
5. **Knowledge graph.** Each finished run is indexed into the graph behind the entity pages (local,
   no model calls).

The app researches one race at a time and queues up to three more; the follow-up steps run beside
the queue, so the next race doesn't wait on them. Pages are server-rendered HTML with no scripts,
readable on a phone.

## Cost

Research runs on Claude Opus 5.5 (`claude-opus-5-5`) by default, at $4 / $20 per million input /
output tokens, plus $10 per 1,000 web searches. The steps after research run on cheaper models:
Claude Sonnet 5.5 for notes on names and campaign finance, Claude Haiku 5.5 for merging duplicates.
Every candidate in a run gets the same model at each step.

Calls that search the web use prompt caching, so when a long call pauses and resumes, the pages it
already read are re-sent at a tenth of the price. Reading a ballot costs a few cents.

Every model call logs one line to the server's output, for example:

```text
[usage] candidate Jane Doe: claude-opus-5-5, 3 request(s), input 40k + cache read 120k + cache write 35k, output 14k, 12 search(es), 6 fetch(es), about $0.91
```

The dollar figure is an estimate at list prices; your Anthropic Console has the real bill. To spend
less, lower `BALLOTFIX_EFFORT` to `medium` (faster too, with somewhat thinner dossiers), pick a
cheaper `BALLOTFIX_MODEL`, or turn a follow-up step off (below).

## Running it

### Settings

| Variable                  | Default             | What it does                                            |
| ------------------------- | ------------------- | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | (none)              | Required to research; saved races still open without it |
| `HOST`, `PORT`            | `127.0.0.1`, `8787` | Listen address                                          |
| `BALLOTFIX_PASSWORD`      | (none)              | Require this password (HTTP Basic, any username)        |
| `BASE_PATH`               | (none)              | Mount prefix, e.g. `/ballotfix` behind a reverse proxy  |
| `BALLOTFIX_DATA_DIR`      | `data`              | Where `ballotfix.db` lives                              |
| `BALLOTFIX_MODEL`         | `claude-opus-5-5`   | Research model                                          |
| `BALLOTFIX_EFFORT`        | `high`              | `low`, `medium`, `high`, `xhigh`, or `max`              |
| `BALLOTFIX_MERGE_MODEL`   | `claude-haiku-5-5`  | Model for merging duplicates; `off` skips the step      |
| `BALLOTFIX_CONTEXT_MODEL` | `claude-sonnet-5-5` | Model for notes on names; `off` skips the step          |
| `BALLOTFIX_FINANCE_MODEL` | `claude-sonnet-5-5` | Model for campaign finance; `off` skips the step        |

Everything (races, ballot readings, your notes and picks, and the knowledge graph) is kept in one
SQLite file, `<BALLOTFIX_DATA_DIR>/ballotfix.db`. JSON files written by older versions are imported
once on start and left in place.

### From your phone

The app listens on localhost by default. To reach it from other devices, for example over Tailscale,
set a password and listen on all interfaces:

```sh
HOST=0.0.0.0 BALLOTFIX_PASSWORD='something long' deno task serve
```

Research spends money on your API key, so never expose it without `BALLOTFIX_PASSWORD`. Form posts
must come from the app's own pages.

### Docker / behind a reverse proxy

`docker-compose.yml` runs the app on `127.0.0.1:8421`, with `BASE_PATH=/ballotfix`, data in a named
volume, and a health check on `/healthz`. It reads `ANTHROPIC_API_KEY`, `BALLOTFIX_PASSWORD`
(required), and optionally `BALLOTFIX_MODEL`, `BALLOTFIX_EFFORT`, the three step models, and
`BASE_PATH` from a `.env` beside it. Behind Caddy, use `handle /ballotfix*`, which keeps the prefix,
not `handle_path`.

CI (`.github/workflows/ci.yml`) runs fmt, lint, typecheck, and tests on every push and pull request,
and deploys `main` to the self-hosted runner with `docker compose up --build -d --wait`.

## Command line

The same research for a single race, without the app:

```sh
deno task dossier --city Fontana --office Mayor
```

```sh
deno task dossier --city Fontana --office Mayor \
  --candidates "Jackie Heredia;Acquanetta Warren;Sal Casillas" --incumbent "Acquanetta Warren" \
  --priorities "housing costs;public safety"
```

Options: `--state` (default `CA`), `--election` (default `2026-11-03`), `--model`, `--effort`,
`--concurrency` (default 3), `--out` (default `out`), and `--no-merge`, `--no-context`,
`--no-finance` to skip follow-up steps. It writes `<out>/<city>-<office>-<election>.json` and
`.html`. Re-render a saved run without calling the API:

```sh
deno task dossier --render out/<file>.json
```

Ballot upload and measures are app-only. `examples/sample.html` shows the page layout with
placeholder data.

## Limits (phase 0)

Web research only. Campaign finance comes from whatever filings the finance step can find and open
on public portals; a portal it can't read is listed as a gap. Council minutes and budget PDFs are
included only when search surfaces them. Paywalled news and social media are blind spots. Notes on
names are found by a heuristic, so some names may be missed (the page says so). It can be wrong:
check anything that matters to your vote at the linked source.

## Development

```sh
deno task check   # fmt, lint, typecheck
```

```sh
deno task test    # no network, no API key needed
```

There is no browser test in CI. For UI changes, run `deno task demo` and drive it with Playwright at
phone width (390px). Project conventions and invariants are in `CLAUDE.md`; the permission policy is
in `SECURITY.md`.
