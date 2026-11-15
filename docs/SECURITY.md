# Security model — LK/Vexa edition

The workbench is one operator's program on one computer. What it protects is the league on disk (against loss,
silent damage and other programs) and the computer (against the page being used from elsewhere).

| Threat | Control |
|---|---|
| A web page in an ordinary browser calls the host | The page and API answer only when the Host header names the lease address and port (421 otherwise), which defeats DNS rebinding; every `/api` route but `/api/health` needs the per-launch `X-VEC1-Token` (403), which another origin cannot read; a change must be `application/json` (415) and, when an Origin is sent, the host's own (403) |
| Another computer on the network | The listener is bound to a loopback address only; nothing listens on a network interface |
| A changed or planted program file | The code of the release (`photon/`, `ui/`, `engine/`) is checked against `RELEASE_MANIFEST.json` before anything opens; a changed, missing or unlisted file refuses the start (exit 4) |
| Script injection in the page | `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'` with no inline script, style or handler; `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, a closed `Permissions-Policy` |
| A lost or damaged league | Every acknowledged line is synced to disk first; ledgers are hash-chained and every frame keeps its CRC-32C; the registry is sealed; damage refuses the open and is named, a cut-off last line is dropped; `store verify` and `--verify-only` re-read everything |
| Two hosts on one folder | An exclusive lock file per data folder (exit 5) |
| Two windows racing | A commit names the registry seal its window saw; a stale one is refused (409) and that window reloads |
| Oversized or malformed requests | Bodies at most 32 MiB, no chunked bodies, strict JSON (no duplicate keys, no NaN, depth ≤ 64), every entry checked against the engine's seals |
| A roster file | Read in the window by the engine's importer, which takes eight declared formats and caps their size; it never reaches the host as a file |

**Residual risks.** A program running as the same user can read the data folder and the page's token: it is
inside the boundary. The page holds the token for its lifetime; closing the window does not revoke it, stopping
the host does. The renderer is the installed browser, and its security is that browser's. macOS listens on
127.0.0.1, which every local program can reach (the guards still apply).
