# Security policy

The permission flags on `deno task dossier` in `deno.jsonc` are this app's policy in executable
form. Phase 0 is deliberately narrow, unlike Parallax Fix:

| Grant                           | Why                                                       |
| ------------------------------- | --------------------------------------------------------- |
| `--allow-net=api.anthropic.com` | The only host it talks to. Web research runs server-side. |
| `--allow-env`                   | `ANTHROPIC_API_KEY`, proxy variables, `DENO_CERT`.        |
| `--allow-read`                  | `.env`, and saved JSON for `--render`.                    |
| `--allow-write=out`             | The output directory only.                                |

The web app (`deno task serve`) adds:

| Grant                                     | Why                                                   |
| ----------------------------------------- | ----------------------------------------------------- |
| `--allow-net=127.0.0.1,localhost,0.0.0.0` | Listening. `0.0.0.0` is for containers and Tailscale. |
| `--allow-write=data,out`                  | Saved runs.                                           |

Starting research spends money on the operator's API key, so the app:

- listens on `127.0.0.1` unless `HOST` says otherwise, and warns if it listens more widely without
  `BALLOTFIX_PASSWORD`;
- when `BALLOTFIX_PASSWORD` is set, requires HTTP Basic auth on every route except `/healthz`,
  compared in constant time;
- refuses POSTs that aren't same-origin (`Sec-Fetch-Site`, then `Origin`; `Origin: null` is
  refused);
- validates every form field, caps candidates at 20, and queues at most three races behind the
  running one;
- only opens run files whose ids match `^[a-z0-9][a-z0-9-]{0,119}$`.

Responses carry the same CSP as the page (plus `form-action 'self'`), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: same-origin`.

Widening any grant means updating `deno.jsonc` and this file together.

Never disable TLS verification or unset `HTTPS_PROXY`.

All research content is untrusted. The generated page escapes every string, allows only http(s)
links (with `rel="noopener noreferrer nofollow"`), contains no JavaScript, and sets a
Content-Security-Policy of `default-src 'none'; style-src 'unsafe-inline'`.
