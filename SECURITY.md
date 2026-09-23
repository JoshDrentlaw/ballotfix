# Security policy

The permission flags on `deno task dossier` in `deno.jsonc` are this app's policy in executable
form. Phase 0 is deliberately narrow, unlike Parallax Fix:

| Grant                           | Why                                                       |
| ------------------------------- | --------------------------------------------------------- |
| `--allow-net=api.anthropic.com` | The only host it talks to. Web research runs server-side. |
| `--allow-env`                   | `ANTHROPIC_API_KEY`, proxy variables, `DENO_CERT`.        |
| `--allow-read`                  | `.env`, and saved JSON for `--render`.                    |
| `--allow-write=out`             | The output directory only.                                |

Widening any grant means updating `deno.jsonc` and this file together.

Never disable TLS verification or unset `HTTPS_PROXY`.

All research content is untrusted. The generated page escapes every string, allows only http(s)
links (with `rel="noopener noreferrer nofollow"`), contains no JavaScript, and sets a
Content-Security-Policy of `default-src 'none'; style-src 'unsafe-inline'`.
