# Ballot Fix

Who's on your local ballot, and what have they actually done? Give Ballot Fix a city and an office.
It finds the candidates and builds one page with a dossier for each: background, record in office,
accomplishments, criticisms, money, endorsements, platform, and community impact. Every fact links
to its source and is tagged by the kind of evidence behind it.

It never ranks or recommends anyone. Every candidate gets the same sections and the same research
effort, and every page says what the run couldn't see.

## Quick start: the app

```sh
cp .env.example .env        # then put your Anthropic API key in it
deno task serve             # open http://127.0.0.1:8787
```

Enter a city, state, office, and election date, then tap **Research this race**. The race page fills
in as each candidate finishes and refreshes itself, so you can leave and come back. Finished races
stay listed on the home page, can be researched again, and can be downloaded as a single HTML file
to share. Everything works on a phone.

If you already know the candidates, open **Already know the candidates?** and list them one per line
in ballot order. That skips the ballot lookup.

To try the app without an API key or any cost, run `deno task demo` (port 8788). It is the real app
with placeholder research.

### Using it from your phone

The app listens on localhost by default. To reach it from other devices, for example over Tailscale,
set a password and listen on all interfaces:

```sh
HOST=0.0.0.0 BALLOTFIX_PASSWORD='something long' deno task serve
```

Research spends money on your API key, so don't expose it without `BALLOTFIX_PASSWORD`. Other
settings: `PORT` (default 8787), `BALLOTFIX_DATA_DIR` (default `data`), `BALLOTFIX_MODEL`,
`BALLOTFIX_EFFORT` (`low` to `max`, default `high`).

## Command line

The same research is available without the app:

```sh
deno task dossier --city Fontana --office Mayor
deno task dossier --city Fontana --office Mayor \
  --candidates "Jackie Heredia;Acquanetta Warren;Sal Casillas" --incumbent "Acquanetta Warren"
```

Other options: `--state` (default `CA`), `--election` (default `2026-11-03`), `--model`, `--effort`,
`--concurrency` (default 3), `--out` (default `out`). Re-render a saved run without calling the API:
`deno task dossier --render out/<file>.json`.

`examples/sample.html` shows the page layout with placeholder data.

## How it works

1. **Ballot.** Claude searches for the official candidate list (county registrar, city clerk) and
   records which kind of source set the order.
2. **Research.** One research session per candidate, a few at a time, with server-side web search
   and page fetch. Output is JSON constrained to the fixed template.
3. **Provenance check.** Facts are shown only if their URL was actually retrieved in that session.
   Others go to a collapsed "unverified" list, as leads rather than findings.
4. **Page.** Server-rendered HTML with no scripts, readable on a phone. The app researches one race
   at a time, a few candidates in parallel, and queues up to three more.

## Cost

Each candidate is one research session with up to 15 searches and 10 page fetches on
`claude-opus-5`. Expect roughly a dollar or two per candidate at `high` effort. Use
`--effort
medium` or `--model` to trade depth for cost.

## Limits (phase 0)

Web search only. Campaign finance portals, council minutes, and budget PDFs are included only when
search surfaces them. Paywalled news and social media are blind spots. It can be wrong: check
anything that matters to your vote at the linked source.

## Development

```sh
deno task check   # fmt, lint, typecheck
deno task test    # no network, no API key needed
```
