# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The edition's component contracts, in the LK/Vexa languages.

  contracts/mssl/*.mssl   MSSL 0.3 records (the observed module/learn subset of the MSSL Writers Corpus 1.0.0):
                          the suite's identity, one record per component, and the qualification of this release
  contracts/ja/*.ja       JA21 JA Core 0.3 contract sources (the suite's provisional grammar): the interfaces the
                          components keep, written as records, enums and functions. They are modeled contracts: no JA
                          Core parser, compiler or VM exists, and nothing here executes them.

    python tools/contracts.py write                write the static MSSL records (from the table below)
    python tools/contracts.py qualify              run the tests, then write contracts/mssl/90_qualification.mssl
    python tools/contracts.py check [--mssl-verifier PATH/TO/VERIFY_MSSL.py]

`check` validates every record with this file's validator, which applies the predicates of the corpus's
tools/VERIFY_MSSL.py (validate_source) to a single document; given --mssl-verifier, it also runs that validator
itself on every record. It checks the JA files as the JA Core suite's tools/validate_suite.py checks its scripts
(source header, module, policy no_network, brace balance), plus the grammar's top-level forms, and cross-checks the
constants the contracts state against the implementation. Nothing in a record is promoted beyond the evidence it
names: a record says OPERATIONAL only with tests that ran, and the qualification names the platform they ran on.
"""
import hashlib
import importlib.util
import json
import os
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "photon"))
from host import ENGINE, VERSION  # noqa: E402

MSSL_DIR = os.path.join(ROOT, "contracts", "mssl")
JA_DIR = os.path.join(ROOT, "contracts", "ja")
ALPHA = {"format": "0.3", "profile": "basic_mssl.executable.3", "record": "MSSL.Document", "source_language": "MSSL", "source_version": "0.3"}
FIELDS = ["α", "ι", "λ", "ℛ", "π", "δ", "τ", "μ", "ρ", "χ", "η", "ν", "κ"]
QUALIFICATION = "90_qualification.mssl"

JA_FILES = ["rinkvt_frame.ja", "rinkvt_loopback.ja", "rinkvt_store.ja", "rinkvt_host.ja"]
COMPONENTS = ["rinkvt.lkvexa.photon_host", "rinkvt.lkvexa.league_store", "rinkvt.lkvexa.loopback_leases",
              "rinkvt.lkvexa.release_integrity", "rinkvt.lkvexa.renderer", "rinkvt.lkvexa.engine"]


def contracts():
    """(file, module, facts) for every static record. Facts are (key, value) in rule order."""
    return [
        ("00_suite_identity.mssl", "rinkvt.lkvexa.suite", [
            ("suite_id", "RINKVT-LKVEXA"),
            ("suite_name", "RINK-VT Workbench, LK/Vexa edition"),
            ("version", VERSION),
            ("engine_version", ENGINE),
            ("role", "hockey statistics workbench: a scorer's command language, 64-byte frames, an event-sourced game actor, statistical models and the HK001 laboratory"),
            ("runtime", "Photon host (Python 3.10 or newer, standard library only) with a Chromium-family renderer window on an isolated profile"),
            ("node_runtime", False),
            ("components", COMPONENTS),
            ("ja_contracts", [f"contracts/ja/{f}" for f in JA_FILES]),
            ("authoritative_source", "bundled: photon/, ui/ and engine/, sealed by RELEASE_MANIFEST.json"),
            ("license", "GPL-3.0-only"),
            ("copyright", "Copyright (C) 2026 RUSSELL PHILIP SMITHSON"),
            ("maturity", "OPERATIONAL"),
            ("evidence", [f"contracts/mssl/{QUALIFICATION}"]),
            ("scope_limit", "as qualified by the qualification record, on the platform it names; other platforms are not qualified by it"),
        ]),
        ("10_photon_host.mssl", "rinkvt.lkvexa.photon_host", [
            ("component", "photon/rinkvt.py, photon/host/server.py"),
            ("contract", "serves the workbench and a JSON API on this computer's static loopback address only; a request whose Host header does not name that address and port is refused (421); every /api route except /api/health needs the per-launch X-VEC1-Token (403); a change is accepted only as application/json from the same origin (415, 403); a body is at most 32 MiB and never chunked (413, 411)"),
            ("interfaces", ["GET /", "GET /workbench.js", "GET /workbench.css", "GET /api/health", "GET /api/edition", "GET /api/league",
                            "GET /api/ledgers?sha=", "GET /api/verify", "POST /api/commit", "POST /api/shutdown"]),
            ("invariants", ["one host per data folder, held by an exclusive lock file",
                            "the code of the release matches RELEASE_MANIFEST.json before anything else is opened; otherwise the start is refused with exit code 4",
                            "requests are not logged; the host's event ledger records starts, commits and stops",
                            "every response carries a Content-Security-Policy of default-src 'self' with no inline script or style"]),
            ("state_model", ["checking the release", "taking the data folder", "opening the league", "leasing the loopback address", "listening", "stopped"]),
            ("exit_codes", {"0": "stopped", "1": "verification failed", "2": "usage", "4": "release integrity", "5": "data folder in use",
                            "6": "the league cannot be opened", "7": "loopback lease or listener"}),
            ("ja_contract", "contracts/ja/rinkvt_host.ja"),
            ("maturity", "OPERATIONAL"),
            ("evidence", ["tests/test_server.py", "tests/test_browser.py"]),
        ]),
        ("20_league_store.mssl", "rinkvt.lkvexa.league_store", [
            ("component", "photon/host/store.py"),
            ("contract", "a commit carries the registry text (optional), the registry seal the window last saw, and the new ledger entry pairs of each game; it is refused unless that seal is current (409), every stored game is kept with its uuid, each batch starts where its ledger ends, and every pair passes the engine's own seals; the answer is sent only after the registry and the ledger lines are synced to disk"),
            ("files", ["league/registry/registry.json", "league/registry/registry.sha256", "league/ledger/<key>-<uuid8>.jsonl", "events.jsonl"]),
            ("seals", {"registry": "SHA-256 of registry.json, kept in registry.sha256 and replaced through registry.sha256.new and two renames",
                       "ledger": "line n carries prev, the hash of line n-1, and hash = SHA-256(prev LF frame-hex meta-hex LF n); the first prev is SHA-256('RINK-VT ledger 1' NUL key NUL uuid)",
                       "frame": "CRC-32C of bytes 0-59, big-endian at bytes 60-63; bytes 32-35 are the first four bytes of the game's uuid",
                       "meta": "magic CMT1 (0x31544D43, little-endian) at bytes 0-3; CRC-32C of bytes 0-59, little-endian at bytes 60-63"}),
            ("recovery", "a last line without its newline was never acknowledged: opening the league drops it; a verification reports it and repairs nothing"),
            ("limits", {"registry_bytes": 16777216, "pairs_per_game": 40000}),
            ("ja_contract", "contracts/ja/rinkvt_store.ja"),
            ("maturity", "OPERATIONAL"),
            ("evidence", ["tests/test_store.py", "tests/test_server.py", "tests/test_browser.py"]),
        ]),
        ("30_loopback_leases.mssl", "rinkvt.lkvexa.loopback_leases", [
            ("component", "photon/host/loopback.py"),
            ("contract", "every IP address keeps one 127.x.y.z address for good: a first lease is written, synced and sealed before the address is used, and every later start gives the same address; for the same pool the reference edition gives the same address"),
            ("pool", "127.16.0.0/12"),
            ("capacity", 1040384),
            ("slot", "the first 16 hex digits of SHA-256('RINK-VT loopback 1' NUL key), modulo the capacity; then linear probing over host addresses .1 to .254"),
            ("keys", "the canonical text of the IP address (RFC 5952; an IPv4-mapped IPv6 address is its IPv4 address); optionally an IPv6 /N prefix"),
            ("file_format", "a header line '# RINK-VT loopback leases · format 1 · pool P · ipv6 /N', then one line per lease: address, key, time and a 16-digit seal"),
            ("refusals", ["an edited or damaged line", "a second lease for one key or one address", "a pool or IPv6 prefix other than the file's", "a full pool"]),
            ("ja_contract", "contracts/ja/rinkvt_loopback.ja"),
            ("maturity", "OPERATIONAL"),
            ("evidence", ["tests/test_loopback.py"]),
        ]),
        ("40_release_integrity.mssl", "rinkvt.lkvexa.release_integrity", [
            ("component", "photon/host/integrity.py, tools/seal_release.py, tools/bundle.py"),
            ("contract", "RELEASE_MANIFEST.json lists every file of the release with its SHA-256; a start is refused when a file under photon/, ui/ or engine/ is changed, missing or unlisted; a verification checks every file; the renderer bundle is built from engine/ and ui/ without Node.js and checked to be current"),
            ("scopes", {"code": "photon/, ui/ and engine/, at every start", "all": "every file, at verification"}),
            ("maturity", "OPERATIONAL"),
            ("evidence", ["tests/test_release.py"]),
        ]),
        ("50_renderer.mssl", "rinkvt.lkvexa.renderer", [
            ("component", "photon/host/renderer.py, ui/"),
            ("contract", "opens the workbench in an installed Edge, Chrome or Chromium in app mode on a profile of its own under the data folder; the page loads only from the host; without such a browser the host says so, and uses the ordinary browser only with --allow-default-browser-fallback"),
            ("page_policy", "default-src 'self'; script-src 'self'; style-src 'self'; no inline script, style or event handler; no external fonts or scripts"),
            ("maturity", "OPERATIONAL"),
            ("evidence", ["tests/test_browser.py", "tests/test_release.py"]),
        ]),
        ("60_engine.mssl", "rinkvt.lkvexa.engine", [
            ("component", "engine/ (32 modules and 3 data tables of the reference edition's engine), ui/loader.js, ui/app.js"),
            ("contract", "the command language, frames, game actor, models, roster importer and HK001 run in the renderer as the reference edition runs them; the window sends the host every change a command made and shows the command's result only after the host has it on disk; when the host refuses, the window loads the league again"),
            ("engine_version", ENGINE),
            ("ja_contract", "contracts/ja/rinkvt_frame.ja"),
            ("maturity", "OPERATIONAL"),
            ("evidence", ["tests/test_browser.py", "tests/test_store.py"]),
            ("scope_limit", "the engine's own test suite belongs to the reference edition (Node.js); this edition exercises the engine through its browser tests"),
        ]),
    ]


# ---- MSSL ---------------------------------------------------------------------------------------------------
def _c(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def mssl_document(identity, module, facts):
    rules = {"0001": "module(" + _c(module) + ")"}
    memory, state = {}, {}
    for i, (key, value) in enumerate(facts, 2):
        literal = value if isinstance(value, str) else _c(value)
        rules[f"{i:04d}"] = "learn(" + _c(key) + ",literal(" + _c(literal) + "))"
        memory["learn." + key] = value
        state[key] = value
    body = ",\n".join([
        "α≡" + _c(ALPHA), "ι≡" + _c(identity), "λ≡" + _c(module), "ℛ≡" + _c(rules), "π≡[]", f"δ≡{len(rules)}", "τ≡0",
        "μ≡" + _c(memory), 'ρ≡{"assertions":[],"emissions":[],"prints":[]}', "χ≡[]", "η≡" + _c({"events": [], "state": state}), "ν≡{}",
    ]) + "\n"
    kappa = "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()
    return "MSSL{\n" + body + ",κ≡" + _c(kappa) + "\n}⇒⊤\n"


class Invalid(ValueError):
    pass


def _no_dup(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise Invalid("duplicate JSON key " + k)
        out[k] = v
    return out


_DEC = json.JSONDecoder(object_pairs_hook=_no_dup)


def validate_mssl(raw):
    """The single-document predicates of the corpus validator (tools/VERIFY_MSSL.py validate_source)."""
    text = raw.decode("utf-8")
    pos = 0

    def ws(p):
        while p < len(text) and text[p].isspace():
            p += 1
        return p
    pos = ws(pos)
    if not text.startswith("MSSL{", pos):
        raise Invalid("invalid envelope prefix")
    pos += 5
    v, alpha_at, kappa_at = {}, None, None
    for n, key in enumerate(FIELDS):
        pos = ws(pos)
        if n:
            if pos >= len(text) or text[pos] != ",":
                raise Invalid("missing comma before " + key)
            if key == "κ":
                kappa_at = pos
            pos = ws(pos + 1)
        if not text.startswith(key + "≡", pos):
            raise Invalid("expected field " + key)
        if key == "α":
            alpha_at = pos
        pos = ws(pos + len(key) + 1)
        v[key], pos = _DEC.raw_decode(text, pos)
    pos = ws(pos)
    if not text.startswith("}⇒⊤", pos) or ws(pos + 3) != len(text):
        raise Invalid("invalid terminal marker or trailing content")
    if not isinstance(v["α"], dict) or v["α"].get("record") != "MSSL.Document" or v["α"].get("format") not in ("0.1", "0.2", "0.3"):
        raise Invalid("unobserved record/format")
    rules = v["ℛ"]
    if not isinstance(rules, dict) or list(rules) != [f"{i:04d}" for i in range(1, len(rules) + 1)]:
        raise Invalid("nonconsecutive rule ids")
    if type(v["δ"]) is not int or v["δ"] != len(rules) or type(v["τ"]) is not int or v["τ"] != 0:
        raise Invalid("delta or tau")
    if not isinstance(v["ρ"], dict) or set(v["ρ"]) != {"assertions", "emissions", "prints"} or not isinstance(v["π"], list) or not isinstance(v["χ"], list) or not isinstance(v["ν"], dict):
        raise Invalid("structural fields")
    learned, modules = {}, []
    for rule in rules.values():
        if rule.startswith("module(") and rule.endswith(")"):
            arg, end = _DEC.raw_decode(rule, 7)
            if end != len(rule) - 1 or not isinstance(arg, str):
                raise Invalid("module form")
            modules.append(arg)
        elif rule.startswith("learn("):
            key, end = _DEC.raw_decode(rule, 6)
            if not rule.startswith(",literal(", end):
                raise Invalid("learn form")
            lit, end = _DEC.raw_decode(rule, end + 9)
            if rule[end:] != "))" or not isinstance(key, str) or not isinstance(lit, str) or key in learned:
                raise Invalid("learn form or duplicate key")
            learned[key] = lit
        else:
            raise Invalid("unobserved operator")
    if modules != [v["λ"]]:
        raise Invalid("module mismatch")
    if set(v["μ"]) != {"learn." + k for k in learned} or v["η"].get("state") != {k: v["μ"]["learn." + k] for k in learned}:
        raise Invalid("memory/state mismatch")
    for k, lit in learned.items():
        value = v["μ"]["learn." + k]
        if isinstance(value, str):
            if lit != value:
                raise Invalid("string literal/memory mismatch " + k)
        else:
            decoded = json.loads(lit)
            if type(decoded) is not type(value) or decoded != value:
                raise Invalid("typed literal/memory mismatch " + k)
    if v["κ"] != "sha256:" + hashlib.sha256(text[alpha_at:kappa_at].encode("utf-8")).hexdigest():
        raise Invalid("kappa mismatch")
    return v


def corpus_validator(path):
    """The MSSL Writers Corpus validator itself, loaded from the user's copy (it only reads)."""
    spec = importlib.util.spec_from_file_location("verify_mssl_corpus", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.validate_source


# ---- JA ----------------------------------------------------------------------------------------------------
TOP = re.compile(r"^(use|import|policy|const|record|enum|variant|function|func|trait|impl|macro|package|let|var|assert|emit|match|return)\b")


def check_ja(path):
    """What tools/validate_suite.py requires of every JA Core script, and the provisional grammar's top-level forms."""
    with open(path, encoding="utf-8") as f:
        text = f.read().rstrip()
    lines = text.split("\n")
    problems = []
    if "ja source" not in text or "module " not in text or "policy no_network" not in text:
        problems.append("required source declarations (ja source, module, policy no_network)")
    if text.count("{") != text.count("}"):
        problems.append("brace balance")
    if text.count("(") != text.count(")") or text.count("[") != text.count("]"):
        problems.append("parenthesis or bracket balance")
    if lines[0] != "ja source 0.3":
        problems.append("line 1 must be the source header 'ja source 0.3'")
    if len(lines) < 2 or not re.fullmatch(r"module [A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*", lines[1]):
        problems.append("line 2 must be 'module qualified.name'")
    depth = 0
    for n, line in enumerate(lines[2:], 3):
        s = line.strip()
        if s and depth == 0 and not TOP.match(s) and not s.startswith("}"):
            problems.append(f"line {n}: not a declaration or statement of the provisional grammar")
        depth += line.count("{") - line.count("}")
        if depth < 0:
            problems.append(f"line {n}: a closing brace without an opening one")
            depth = 0
        if "\t" in line:
            problems.append(f"line {n}: a tab (the suite's scripts indent with spaces)")
    return problems


def cross_checks():
    """Constants the contracts state, checked against the implementation that keeps them."""
    from host.crc32c import crc32c
    from host.loopback import DEFAULT_POOL, LeaseTable, Pool
    from host.server import MAX_BODY, TOKEN_HEADER
    from host.store import MAX_PAIRS_PER_GAME, MAX_REGISTRY, META_MAGIC
    ja = {}
    for f in JA_FILES:
        with open(os.path.join(JA_DIR, f), encoding="utf-8") as fh:
            ja[f] = fh.read()
    want = [
        ("rinkvt_frame.ja", 'Crc32c.of(Bytes.text("123456789")) == ' + str(crc32c(b"123456789", 9))),
        ("rinkvt_frame.ja", "meta_magic: Count = " + str(META_MAGIC)),
        ("rinkvt_loopback.ja", f'base: "{DEFAULT_POOL.split("/")[0]}", prefix_length: {DEFAULT_POOL.split("/")[1]}, capacity: {Pool(DEFAULT_POOL).capacity}'),
        ("rinkvt_loopback.ja", f'first_address(canonical_key("203.0.113.5"), default_pool) == "{LeaseTable().lease("203.0.113.5")[0]}"'),
        ("rinkvt_store.ja", f"max_registry_bytes: Count = {MAX_REGISTRY}"),
        ("rinkvt_store.ja", f"max_pairs_per_game: Count = {MAX_PAIRS_PER_GAME}"),
        ("rinkvt_host.ja", f'token_header: Text = "{TOKEN_HEADER}"'),
        ("rinkvt_host.ja", f"max_body_bytes: Count = {MAX_BODY}"),
    ]
    return [f"{f}: does not state {w!r} (the implementation's value)" for f, w in want if w not in ja[f]]


# ---- the commands -------------------------------------------------------------------------------------------
def write_static():
    os.makedirs(MSSL_DIR, exist_ok=True)
    for name, module, facts in contracts():
        text = mssl_document(f"mssl:rinkvt:lkvexa:{module.split('.')[-1]}:{VERSION}", module, facts)
        with open(os.path.join(MSSL_DIR, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    print(f"contracts/mssl: {len(contracts())} records written")


def qualify(argv):
    """Run the test suite and record what it showed, no more."""
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", RINKVT_QUALIFY="1")
    cmd = [sys.executable, "-I", "-B", "-m", "unittest", "discover", "-s", os.path.join(ROOT, "tests"), "-p", "test_*.py", "-v"]
    p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = p.stdout + p.stderr
    m = re.search(r"^Ran (\d+) tests? in", out, re.M)
    ran = int(m.group(1)) if m else 0
    skipped = len(re.findall(r" \.\.\. skipped", out))
    failed = len(re.findall(r" \.\.\. (FAIL|ERROR)$", out, re.M))
    modules = sorted({x for x in re.findall(r"\((test_[a-z_]+)\.", out)})
    browser = re.search(r"^RINKVT-BROWSER (.+)$", out, re.M)
    passed = ran - skipped - failed
    ok = p.returncode == 0 and ran > 0
    corpus_ran = re.search(r"test_the_corpus_validator_accepts_them \([^)]*\) \.\.\. ok", out) is not None
    scope = ["the host, store, lease, release and contract tests of this edition"]
    scope.append(f"the browser tests in {browser.group(1).strip()}" if browser and "test_browser" in modules and not re.search(r"test_browser\.[A-Za-z]+\)[^\n]* \.\.\. skipped", out)
                 else "no browser tests (Playwright or a Chromium build was not available)")
    facts = [
        ("target", f"RINK-VT {VERSION} (engine {ENGINE})"),
        ("result", "PASS" if ok else "BLOCKED"),
        ("checks", ran),
        ("passed", passed),
        ("skipped", skipped),
        ("failed", failed),
        ("covered", [f"tests/{m}.py" for m in modules]),
        ("evidence", ["python -I -B -m unittest discover -s tests -p test_*.py"]),
        ("mssl_corpus_validator", "ran on every static record (MSSL Writers Corpus tools/VERIFY_MSSL.py)" if corpus_ran else "not available on the qualifying computer"),
        ("platform", f"{platform.system()} {platform.release()} {platform.machine()} · Python {platform.python_version()}"),
        ("run_at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
        ("scope_limit", "; ".join(scope) + "; on this platform only. Other operating systems, and the launchers START_RINKVT and VERIFY_RINKVT on them, are not qualified by this record"),
    ]
    os.makedirs(MSSL_DIR, exist_ok=True)
    with open(os.path.join(MSSL_DIR, QUALIFICATION), "w", encoding="utf-8", newline="\n") as f:
        f.write(mssl_document(f"mssl:rinkvt:lkvexa:qualification:{VERSION}", "rinkvt.lkvexa.qualification", facts))
    print(out[-1500:] if not ok else f"qualification: {'PASS' if ok else 'BLOCKED'} · {ran} checks · {passed} passed · {skipped} skipped · {failed} failed")
    return 0 if ok else 1


def check(argv):
    problems = []
    corpus = None
    if "--mssl-verifier" in argv:
        corpus = corpus_validator(argv[argv.index("--mssl-verifier") + 1])
    expected = {name: mssl_document(f"mssl:rinkvt:lkvexa:{module.split('.')[-1]}:{VERSION}", module, facts) for name, module, facts in contracts()}
    present = sorted(f for f in os.listdir(MSSL_DIR) if f.endswith(".mssl")) if os.path.isdir(MSSL_DIR) else []
    for name in sorted(set(expected) | set(present) | {QUALIFICATION}):
        path = os.path.join(MSSL_DIR, name)
        if not os.path.exists(path):
            problems.append(f"contracts/mssl/{name}: missing" + (" (python tools/contracts.py qualify)" if name == QUALIFICATION else " (python tools/contracts.py write)"))
            continue
        with open(path, "rb") as fh:
            raw = fh.read()
        try:
            v = validate_mssl(raw)
            if corpus:
                corpus(raw)
        except Exception as e:  # noqa: BLE001
            problems.append(f"contracts/mssl/{name}: {e}")
            continue
        if name in expected and raw.decode("utf-8") != expected[name]:
            problems.append(f"contracts/mssl/{name}: not what tools/contracts.py writes (stale; run write)")
        if name == QUALIFICATION:
            state = v["η"]["state"]
            if not str(state.get("target", "")).startswith(f"RINK-VT {VERSION} "):
                problems.append(f"contracts/mssl/{name}: qualifies {state.get('target')}, not {VERSION} (run qualify)")
            if state.get("result") != "PASS":
                problems.append(f"contracts/mssl/{name}: the last qualification was {state.get('result')}")
        if name not in expected and name != QUALIFICATION:
            problems.append(f"contracts/mssl/{name}: not a contract of this edition")
    for f in JA_FILES:
        path = os.path.join(JA_DIR, f)
        if not os.path.exists(path):
            problems.append(f"contracts/ja/{f}: missing")
            continue
        problems += [f"contracts/ja/{f}: {p}" for p in check_ja(path)]
    problems += cross_checks()
    for p in problems:
        print("FAIL " + p)
    n = len(expected) + 1
    print(("PASS" if not problems else "FAIL") + f" · {n} MSSL records" + (" (also by the corpus validator)" if corpus else "") + f" · {len(JA_FILES)} JA contracts · constants cross-checked")
    return 0 if not problems else 1


def main(argv):
    if not argv or argv[0] not in ("write", "qualify", "check"):
        print(__doc__)
        return 2
    return {"write": lambda: (write_static(), 0)[1], "qualify": lambda: qualify(argv[1:]), "check": lambda: check(argv[1:])}[argv[0]]()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
