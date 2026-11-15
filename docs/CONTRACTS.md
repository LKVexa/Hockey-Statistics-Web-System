# Component contracts — MSSL records and JA21 sources

The edition describes its components in the LK/Vexa languages. The descriptions are checked; they do not replace
the code, and nothing in them is promoted beyond the evidence it names.

## MSSL records (`contracts/mssl/`)

MSSL 0.3 documents in the observed `module`/`learn` subset of the MSSL Writers Corpus 1.0.0 (profile
`basic_mssl.executable.3`): the field order `α ι λ ℛ π δ τ μ ρ χ η ν κ`, one `module` rule equal to `λ`, one
`learn` rule per fact, `μ` and `η.state` as the typed projection of the facts, and the seal
`κ = sha256:` + SHA-256 of the exact UTF-8 text from `α≡` up to the comma of `,κ≡`.

| Record | Module | Says |
|---|---|---|
| `00_suite_identity.mssl` | `rinkvt.lkvexa.suite` | product, versions, runtime (no Node.js), components, licence |
| `10_photon_host.mssl` | `rinkvt.lkvexa.photon_host` | routes, guards, invariants, states, exit codes |
| `20_league_store.mssl` | `rinkvt.lkvexa.league_store` | the commit contract, files, seals, recovery, limits |
| `30_loopback_leases.mssl` | `rinkvt.lkvexa.loopback_leases` | per-laptop addresses (device key, device file, pin, fleet register), pool, slot function, formats 1 and 2, refusals |
| `40_release_integrity.mssl` | `rinkvt.lkvexa.release_integrity` | the manifest, the two scopes, the bundle check |
| `50_renderer.mssl` | `rinkvt.lkvexa.renderer` | the window and the page policy |
| `60_engine.mssl` | `rinkvt.lkvexa.engine` | what runs in the window and how a command is recorded |
| `90_qualification.mssl` | `rinkvt.lkvexa.qualification` | written by `tools/contracts.py qualify` from a test run: result, counts, platform, scope |

Records 00–60 are written by `python tools/contracts.py write` from the table in `tools/contracts.py`, so a change
to a contract is a change to that table. Record 90 is written only by `qualify`, which runs the whole test suite and
records what it showed: `PASS` only when every test passed, the platform it ran on, and what was not covered.

## JA21 sources (`contracts/ja/`)

JA Core 0.3 sources in the provisional grammar of the JA21 JA Core Application Language Suite 1.0.0: a source
header, a module, `use Core`, `policy no_network`, then records, enums, constants and functions with effect clauses,
and a few top-level assertions on sample values.

| Source | Module | Describes |
|---|---|---|
| `rinkvt_frame.ja` | `rinkvt.contract.frame` | the 64-byte frame, the meta line, and the pair check the store applies |
| `rinkvt_loopback.ja` | `rinkvt.contract.loopback` | the device key, canonical IP keys, the slot function, a lease with a pin, a laptop's lease through its fleet register |
| `rinkvt_store.ja` | `rinkvt.contract.store` | a commit: admission (seal, games, start, size) then sealed, chained, synced writes |
| `rinkvt_host.ja` | `rinkvt.contract.host` | request admission: Host, Origin, media type, token, length |

They are **modeled contracts**. The JA21 suite supplies no JA Core parser, compiler or VM, and this edition does
not claim one: nothing executes these files. They are checked as the suite's `tools/validate_suite.py` checks its
own scripts (the source header, `module`, `policy no_network`, brace balance), against the grammar's top-level
forms, and — what makes them more than prose — every constant they state (the CRC-32C check value, the meta magic,
the pool and its capacity, the first lease of 203.0.113.5, a device key and its first address, the store's limits, the token header, the body limit) is
compared with the implementation's own value by `tools/contracts.py check`.

## Checking

```
python tools/contracts.py check
python tools/contracts.py check --mssl-verifier <MSSL_WRITERS_CORPUS_1.0.0>/tools/VERIFY_MSSL.py
RINKVT_MSSL_VERIFIER=<…>/VERIFY_MSSL.py python -m unittest discover -s tests -p "test_*.py"
```

The corpus validator is used, not copied: `--mssl-verifier` loads `validate_source` from your copy of the corpus
and applies it to every record, in addition to this repository's own implementation of the same predicates.
