# RINK-VT Workbench — LK/Vexa edition

**2.5.0-lkvexa.2 · Photon-hosted · no Node.js · GPL-3.0-only**

RINK-VT is a hockey statistics workbench. A scorer types one fact per line in a scorer's language —
`FOCO SMIT G/2P` — and the line becomes one or more 64-byte frames that an event-sourced game actor applies. Box
scores, expected goals, stints, RAPM, GSAx, GAR/WAR, NHLe and heat maps are computed from those frames, and every
HK001 computation is a command of its own.

This is the **LK/Vexa ecosystem edition**. It runs the engine of RINK-VT 2.5.0-rinkvt.1 (the reference edition, the
HERMIT gateway on Node.js) in a browser window, and replaces Node.js with a **Photon host**: a small Python program,
standard library only, that serves the workbench on this computer's own static loopback address, keeps the league on
disk in sealed, hash-chained files, and opens the window. The components carry contracts in the LK/Vexa languages:
MSSL records and JA21 sources, checked by the tools in this repository and by the MSSL corpus validator.

The handguide — the full technical and operating manual for both editions, document RVT-HG-001 — is
[`docs/handguide/RINK-VT_Handguide.pdf`](docs/handguide/RINK-VT_Handguide.pdf). `python docs/handguide/build.py` rebuilds it from
its sources with Chromium (Playwright for Python) and pypdf; its appendices are generated from the release itself.

All clubs, players and games shipped with it are fictional demonstration data. HK001 is a deterministic synthetic
research laboratory; it gives no forecasts, odds, or roster, medical, scouting or officiating advice.

## Requirements

- **Python 3.10 or newer.** Nothing else is installed: the host uses the standard library only.
- **Microsoft Edge, Google Chrome or Chromium**, for the window. The host opens it in app mode with a profile of its
  own (no extensions, cookies or sessions of your ordinary browser). Without one, it prints the address to open, and
  `--allow-default-browser-fallback` uses your ordinary browser instead.
- A few megabytes of disk for the program, and about half a megabyte per scored game.

## Start

| System | Start | Verify |
|---|---|---|
| Windows | double-click `START_RINKVT.cmd` | `VERIFY_RINKVT.cmd` |
| macOS, Linux | `./START_RINKVT.sh` | `./VERIFY_RINKVT.sh` |
| any | `python -I -B photon/rinkvt.py` | `python -I -B tools/verify.py` |

The host prints what it did and the address it serves, then opens the workbench:

```
RINK-VT 2.5.0-lkvexa.2 · LK/Vexa edition (Photon-hosted)
  loopback 127.26.220.77 · static for this laptop (device 786ccb4a)
  workbench  http://127.20.66.113:8800/
  league     C:\RINK-VT\runtime (0 games)
  The listener is loopback only; Host, Origin and a per-launch token guard it. Ctrl+C stops the host.
```

A first session:

```
rink new FOCO KELW           creates G1 (the four demonstration clubs are seeded into an empty league)
rink G1                      RINK mode on G1
T 20:00 P1                   the scoreboard clock, standing still
LINE FOCO SMIT HALA GOUL VAHN MORE
START                        the start frame: the opening faceoff; the clock runs from here, never before
FOCO SMIT FOW/N
FOCO GOUL S/1W               a shot: xG, danger class, the latched clock
FOCO SMIT G/2P               a goal
FOCO HALA A                  the primary assist, chained to the open goal
Q BOX · Q XG · Q AUDIT       queries; HELP lists the language
EXIT
rink sim 4                   four synthetic games typed through the same command path
OFF-001 --team FOCO --season an HK001 equation over the season
store verify                 every seal and chain of the league, re-read from disk
```

**A new game's clock waits for START.** Creating a game, setting the clock, lineups and the first faceoff never start
it; `START` — the game's start frame, recorded in the ledger — does, and `GO` is refused until then. `GO` restarts the
clock after a stoppage or a period break.

**Each line is recorded before its result is shown.** After a command changes the league, the window sends the
host what changed and waits until the host has synced it to disk. If the host refuses (another window changed the
league first) or cannot be reached, the window says **NOT RECORDED** and loads the league again, so it only ever
shows what is on disk.

## Options

```
python photon/rinkvt.py [--data DIR] [--port N] [--device-file FILE] [--fleet FILE] [--leases FILE] [--pool 127.16.0.0/12]
                        [--no-browser] [--allow-default-browser-fallback] [--verify-only] [--version]
```

| Option | Meaning |
|---|---|
| `--data DIR` | the data folder (default `runtime/` beside the program): the league, the event ledger, the lease table, the window's profile |
| `--port N` | a fixed port; by default the first free one of 8800–8829 |
| `--device-file FILE` | this laptop's device file (its identity and pinned address); by default in the user's application data |
| `--fleet FILE` | the fleet register every laptop of the club or league shares; remembered once given |
| `--leases FILE` | this league's lease table (default `DIR/loopback/leases`) |
| `--pool CIDR` | where leases come from: inside 127.0.0.0/8, never overlapping 127.0.0.0/16, prefix /9 to /24 |
| `--verify-only` | check the release and the league, print a JSON report, exit (0 = verified) |

Exit codes: 0 stopped · 1 verification failed · 2 usage · 4 release integrity · 5 data folder in use · 6 the league
cannot be opened · 7 device file, loopback lease or listener.

## The data folder

```
runtime/
  league/registry/registry.json     leagues, teams, players, games, notes (schema rinkvt.registry.v1)
  league/registry/registry.sha256   its SHA-256 (sha256sum -c compatible)
  league/ledger/G1-3913755b.jsonl   one ledger per game: a header line, then one line per frame and its meta line
  events.jsonl                      the host's own hash-chained event ledger (start, commit, stop)
  loopback/leases                   which laptop held which 127 address in this league
  browser_profile/                  the window's own browser profile
  .rinkvt.lock                      held while a host has the folder open
```

Every ledger line carries the hash of the line before it, and each frame keeps the engine's CRC-32C, so a ledger is
verified from its first line to its last. A line cut off by a power cut was never acknowledged: opening the league
drops it. Any other damage refuses to open the league, and `--verify-only` names the file and line.

**Back up** by copying the data folder after stopping the host (**stop host** in the window, or Ctrl+C). **Restore**
by putting the folder back, then run `--verify-only` on it. A league can be checked without a host:
`python photon/rinkvt.py --verify-only --data COPY` reads it and writes nothing.

## Every laptop keeps its own 127 address

Each laptop that runs the workbench gets one address in `127.16.0.0/12` and keeps it — on every network, in every
league, after every restart and reinstall of RINK-VT — and no two laptops ever hold the same one in a league. The
address belongs to the laptop, not to its IP address (which changes with every network): it is leased to a
**device key** derived from the operating system's machine identifier (Windows MachineGuid, macOS IOPlatformUUID,
Linux machine-id) as an HMAC-SHA-256 digest, so the identifier itself is never stored. The laptop's **device file**
(`%LOCALAPPDATA%\RINK-VT\device.json`, `~/Library/Application Support/RINK-VT/device.json` or
`~/.local/share/rink-vt/device.json`) keeps the key and the **pinned** address, which every league's lease table is
asked for first.

To make the laptops of a club or league unique everywhere, whichever leagues they open, enrol them once in a shared
**fleet register** (a lease table on a share or a USB disk): `START_RINKVT.cmd --fleet E:\rinkvt\fleet-leases`, or
`python tools/leases.py --enroll E:\rinkvt\fleet-leases`. The register is remembered; when it cannot be reached, the
pinned address is used. Two laptops that never shared a register and meet in one league are kept apart there, with a
warning.

Every line typed into a game records the laptop's address (the meta line's bytes 52–55), so `Q AUDIT` shows which
laptop typed what. `python tools/leases.py --this-laptop` shows the laptop's identity and address. Windows and Linux
answer on the whole of 127.0.0.0/8; macOS answers only on 127.0.0.1 unless an alias is added, so there the host
listens on 127.0.0.1 and still records the laptop's address.

## Verification and contracts

`VERIFY_RINKVT` runs, in order: the release against `RELEASE_MANIFEST.json`, the league (seals and chains), the
renderer bundle (rebuilt from `engine/` and `ui/` by `tools/bundle.py`, no Node.js), the contracts, and the tests.

`contracts/mssl/` holds MSSL 0.3 records — the suite's identity, one record per component, and the qualification of
this release, written from an actual test run. `contracts/ja/` holds JA21 JA Core 0.3 contract sources for the frame,
the store, the lease table and the host API. `python tools/contracts.py check` validates them; with
`--mssl-verifier PATH/TO/MSSL_WRITERS_CORPUS_1.0.0/tools/VERIFY_MSSL.py` it also runs the corpus's own validator on
every record. The JA sources are **modeled contracts**: no JA Core parser, compiler or VM exists, and nothing executes
them. See [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Repository layout

```
photon/rinkvt.py          the host's entry point          photon/host/      server, store, leases, integrity, renderer
ui/                       the page: loader, app, styles, and the built bundle (workbench.js)
engine/                   the reference edition's engine sources (32 modules, 3 data tables)
contracts/                MSSL records and JA21 sources    tools/            bundle, seal, contracts, leases, verify
tests/                    unit, API and browser tests       docs/             handguide (PDF and its source), security, contracts
```

## Relationship to the reference edition

The reference edition, HERMIT + RINK-VT 2.5.0-rinkvt.1, is a multi-user gateway on Node.js: terminals (SPIRAL), a
browser dashboard, principals and capabilities, live feeds, the SSD-RAM ledger and Docker deployment. This edition is
one operator's workbench on one computer, with the same engine and language and its own durable store. The two
editions share the lease algorithm, the frame and meta-line formats and the registry schema; they do not share a data
folder format (the reference edition's ledgers are SSD-RAM files, this edition's are JSON-lines chains).

## Limits

- Qualified by its tests on the platform named in `contracts/mssl/90_qualification.mssl`. The Windows and macOS
  launchers are written for those systems but were not executed for this release.
- One host per data folder, one operator identity (`operator@local`). Several windows may be open on one host;
  the second to change the league after the first is refused and reloads.
- The browser keeps the whole league in memory, as the reference bench does: comfortable up to a few hundred games.

## Licence

Copyright (C) 2026 RUSSELL PHILIP SMITHSON. Licensed under the GNU General Public License, version 3 only
(GPL-3.0-only); see [`LICENSE`](LICENSE), [`COPYRIGHT`](COPYRIGHT) and [`NOTICE`](NOTICE). This program comes with
no warranty.
