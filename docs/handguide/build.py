# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Build the RINK-VT Technical Handguide (docs/handguide/RINK-VT_Handguide.pdf) from its sources, without Node.js.

    python docs/handguide/build.py [--out FILE] [--html FILE]

Needs Playwright for Python with a Chromium build (python -m playwright install chromium) and pypdf.

The chapters are HTML fragments in docs/handguide/chapters/. This script numbers their headings, tables and figures,
resolves cross-references ({{ref:key}}), generates the appendices from the engine itself (the command pack, the stat
tokens, the query flags, the 109 HK001 inputs and the 563 computation codes, read by running the engine bundle in
Chromium), from the test suite and from the contract files, and lays the whole out as one document. Chromium prints
it twice, the second time with the page numbers the first pass found; running headers, footers and page numbers are
then printed over each page, and pypdf adds the page labels, the bookmarks and the document information.
"""
import argparse
import datetime
import html
import io
import json
import os
import re
import sys
import unittest

HG = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HG))
sys.path.insert(0, os.path.join(ROOT, "photon"))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from host import ENGINE, VERSION  # noqa: E402

DOC_ID = "RVT-HG-001"
REVISION = "1.2"
ISSUED = datetime.date(2026, 11, 15)
TITLE = "RINK-VT Workbench — Technical Handguide"
REFERENCE = "2.5.0-rinkvt.1"

PARTS = [
    ("I", "Orientation", ["01-scope", "02-overview", "03-getting-started"]),
    ("II", "Operation", ["04-host", "05-workbench", "06-language", "07-rosters", "08-recording", "09-loopback", "10-backup"]),
    ("III", "Technical reference", ["11-architecture", "12-formats", "13-api", "14-engine", "15-security"]),
    ("IV", "Assurance", ["16-verification", "17-tests", "18-contracts", "19-limits"]),
    ("V", "The reference edition", ["20-reference"]),
]
APPENDICES = [
    ("A", "gen:commands"), ("B", "gen:tokens"), ("C", "gen:queries"), ("D", "gen:inputs"), ("E", "gen:codes"),
    ("F", "gen:contracts"), ("G", "21-glossary"), ("H", "22-licence"),
]
FRONT = ["00-control"]


def esc(s):
    return html.escape(str(s), quote=True)


def read(*p):
    with open(os.path.join(*p), encoding="utf-8") as f:
        return f.read()


# ---- generated material --------------------------------------------------------------------------------------
EXTRACT = r"""() => {
  const R = EngineRequire;
  const cat = R('rink/hk001/catalog.js'), inp = R('rink/hk001/inputs.js'), pack = R('src/main/spiral/commands/rink.js');
  const H = R('rink/shared/hcl.js'), Q = R('rink/server/query.js'), codes = R('rink/shared/codes.js');
  const isCode = (n) => /^(HKI-\d{3}|[A-Z0-9]+(-[A-Z0-9]+)+)$/.test(n);
  return {
    catalog: cat.CATALOG.map((c) => ({ code: c.code, stage: c.stage, family: c.family || '', label: c.label || '', unit: c.unit || '',
      published: !!c.published, symbol: c.symbol || '', formula: c.formula || '', status: c.status || '' })),
    stats: cat.stats ? cat.stats() : null, plates: cat.PLATES ? cat.PLATES.size : null,
    inputs: inp.INPUTS.map((i) => ({ code: i.code, field: i.field, label: i.label, unit: i.unit, scope: i.scope, family: i.family, cls: i.cls, tokens: i.tokens, rink: i.rink })),
    commands: pack.filter((d) => !isCode(d.name)).map((d) => ({ name: d.name, aka: d.aka || [], summary: d.summary || '', usage: d.usage || '' })),
    codeCommands: pack.filter((d) => isCode(d.name)).length,
    tokens: Object.entries(H.STATS).map(([k, v]) => ({ token: k, kind: v.kind, label: v.label, inputs: inp.INPUTS.filter((x) => x.tokens.includes(k)).map((x) => x.code) })),
    shotTypes: H.SHOT_TYPES, flags: H.FLAGS, infractions: H.INFRACTIONS, aliases: H.FR, periods: H.PERIODS, maxPeriod: H.MAX_PERIOD,
    queryTakes: H.Q_TAKES, querySwitches: H.Q_SWITCHES, targets: Q.TARGETS, reserved: codes.RESERVED_TEAMS || [],
  };
}"""


def extract_engine(browser):
    from bundle import engine_js
    page = browser.new_page()
    page.set_content("<!doctype html><html><body></body></html>")
    page.add_script_tag(content=engine_js())
    data = page.evaluate(EXTRACT)
    page.close()
    return data


def test_inventory():
    loader = unittest.TestLoader()
    suite = loader.discover(os.path.join(ROOT, "tests"), pattern="test_*.py", top_level_dir=os.path.join(ROOT, "tests"))
    out = []

    def walk(s):
        for t in s:
            if isinstance(t, unittest.TestSuite):
                walk(t)
            else:
                tid = t.id()
                if tid.startswith("unittest.loader"):
                    continue
                mod, cls, meth = tid.split(".")[-3:]
                cls_doc = (sys.modules[t.__class__.__module__].__doc__ or "").strip().split("\n")[0]
                out.append({"module": mod, "cls": cls, "method": meth, "doc": (t._testMethodDoc or "").strip().split("\n")[0], "module_doc": cls_doc})
    walk(suite)
    return out


def contract_files():
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import contracts as C
    recs = []
    for name in sorted(os.listdir(C.MSSL_DIR)):
        if not name.endswith(".mssl"):
            continue
        raw = open(os.path.join(C.MSSL_DIR, name), "rb").read()
        v = C.validate_mssl(raw)
        recs.append({"file": name, "module": v["λ"], "identity": v["ι"], "rules": v["δ"], "kappa": v["κ"], "state": v["η"]["state"], "text": raw.decode("utf-8")})
    ja = [{"file": f, "text": read(C.JA_DIR, f)} for f in C.JA_FILES]
    return recs, ja


def table(rows, head, cls="t", key=None, caption=None, widths=None):
    cols = "".join(f'<col style="width:{w}">' for w in widths) if widths else ""
    attrs = (f' key="{key}"' if key else "") + (f' caption="{esc(caption)}"' if caption else "")
    h = "".join(f"<th>{c}</th>" for c in head)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<table class="{cls}"{attrs}><colgroup>{cols}</colgroup><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table>'


def gen_commands(d):
    rows = [(f"<code>{esc(c['name'])}</code>" + (f"<br><span class=dim>also {', '.join(esc(a) for a in c['aka'])}</span>" if c["aka"] else ""), esc(c["summary"]),
             "<code class=wrap>" + esc(c["usage"]) + "</code>") for c in d["commands"]]
    return ("<h1>Command reference</h1>"
            "<p>The commands of the workbench, as the engine itself declares them (name, summary and usage line, read from "
            "<code>src/main/spiral/commands/rink.js</code> when this guide was built). Inside RINK mode, a line that is not a line of "
            "the scorer's language runs as one of these commands. Every HK001 computation code and input code is a command of its own "
            f"as well: {d['codeCommands']} of them, listed in Appendices D and E. The workbench adds <code>store</code>, "
            "<code>store verify</code>, <code>help</code> and <code>clear</code> ({{ref:store-commands}}).</p>"
            + table(rows, ["Command", "Summary", "Usage"], key="tbl-commands", caption="Commands of the engine's command pack", widths=["14%", "30%", "56%"]))


def gen_tokens(d):
    rows = [(f"<code>{esc(t['token'])}</code>", esc(t["kind"]), esc(t["label"]), " ".join(f"<code>{c}</code>" for c in t["inputs"]) or "—") for t in d["tokens"]]
    st = [(f"<code>/{k}</code>", esc(v.title())) for k, v in d["shotTypes"].items()]
    fl = [(f"<code>/{k}</code>", esc(v)) for k, v in d["flags"].items()]
    inf = [(f"<code>/{k}</code>", esc(v)) for k, v in d["infractions"].items()]
    al = [(f"<code>{esc(k)}</code>", f"<code>{esc(v)}</code>") for k, v in d["aliases"].items()]
    per = {}
    for k, v in d["periods"].items():
        per.setdefault(v, []).append(k)
    pr = [(str(n), " ".join(f"<code>{esc(x)}</code>" for x in sorted(ks, key=lambda s: (len(s), s)))) for n, ks in sorted(per.items())]
    half = (len(inf) + 1) // 2
    inf_rows = [(a[0], a[1], b[0] if b else "", b[1] if b else "") for a, b in zip(inf[:half], inf[half:] + [None])]
    return ("<h1>Stat tokens and modifiers</h1>"
            "<p>The tables in this appendix are generated from the lexer tables of <code>rink/shared/hcl.js</code> and the input table of "
            "<code>rink/hk001/inputs.js</code>. The last column of the first table lists the HK001 input codes that count the token.</p>"
            + table(rows, ["Token", "Kind", "Meaning", "HK001 inputs fed"], key="tbl-tokens", caption="Stat tokens", widths=["9%", "11%", "40%", "40%"])
            + "<h2>Shot types and flags</h2>"
            + table(st + fl, ["Modifier", "Meaning"], key="tbl-shot-mods", caption="Shot-type and flag modifiers", widths=["20%", "80%"])
            + "<h2>Penalty infractions</h2>"
            + table(inf_rows, ["Code", "Infraction", "Code", "Infraction"], key="tbl-infractions", caption="Infraction codes taken by penalty tokens", widths=["12%", "38%", "12%", "38%"])
            + "<h2>Period names</h2>"
            + table(pr, ["Period", "Accepted names"], key="tbl-periods", caption=f"Period names (at most {d['maxPeriod']} periods)", widths=["12%", "88%"])
            + "<h2>French aliases (fr-CA)</h2><p>With <code>LOCALE fr-CA</code>, these aliases compile to the canonical token before a frame is made.</p>"
            + table(al, ["Alias", "Canonical token"], key="tbl-aliases", caption="fr-CA aliases", widths=["30%", "70%"])
            + "<h2>Reserved words</h2><p>These four-letter words of the language can never be team codes: "
            + ", ".join(f"<code>{esc(w)}</code>" for w in d["reserved"]) + ".</p>")


FLAG_TEXT = {"game": "<code>--game=G#</code>", "season": "<code>--season</code>", "team": "<code>--team=TEAM</code>", "n": "<code>--n=N</code>",
             "str": "<code>--str=ALL|EV|PP|ST|5v5…</code>", "min": "<code>--min=N</code>", "steps": "<code>--steps=K</code>",
             "engine": "<code>--engine=js|xpu|auto</code>", "lanes": "<code>--lanes=…</code>", "packed": "<code>--packed</code>"}


def gen_queries(d):
    rows = []
    for t in d["targets"]:
        take = d["queryTakes"].get(t) or d["queryTakes"].get("GAR" if t == "WAR" else t)
        flags, nargs = (take or [[], 0])
        rows.append((f"<code>Q {esc(t)}</code>", ", ".join(FLAG_TEXT.get(f, f"<code>--{f}</code>") for f in flags) or "—", str(nargs)))
    return ("<h1>Query targets and flags</h1>"
            "<p>Generated from <code>Q_TAKES</code> in <code>rink/shared/hcl.js</code> and <code>TARGETS</code> in "
            "<code>rink/server/query.js</code>. Each query accepts only its own flags and refuses any other, so a mistyped filter "
            "never returns an unfiltered answer. <code>WAR</code> is <code>GAR</code> expressed in wins. The third column is the number "
            "of positional arguments the target takes (for example <code>Q PLAYER TEAM CODE</code>).</p>"
            + table(rows, ["Target", "Flags it accepts", "Arguments"], key="tbl-query-flags", caption="Query targets", widths=["18%", "70%", "12%"]))


def gen_inputs(d):
    rows = [(f"<code>{i['code']}</code>", f"<code>{esc(i['field'])}</code>", esc(i["label"]), esc(i["unit"]), esc(i["scope"]), esc(i["cls"]),
             " ".join(f"<code>{esc(t)}</code>" for t in i["tokens"]) or "—") for i in d["inputs"]]
    return ("<h1>HK001 input codes</h1>"
            f"<p>The {len(d['inputs'])} inputs HK001 reads, each with its permanent code, the field name HK001 uses, its unit, scope and "
            "derivation class, and the stat tokens counted for it (generated from <code>rink/hk001/inputs.js</code>). Derivation classes: "
            "TOKEN (counted tokens), STATE (the game-state actor), CLASS (location-based classes, RINKVT-DANGER-v1), INFER (declared "
            "sequence rules), RESULT (final game states), GOALIE (per-goalie games), PLAYER (the case's featured player), OPPONENT "
            "(the opponents' own inputs), LEAGUE (pooled over every team in scope). The full derivation rule of each input is shown by "
            "its command, for example <code>HKI-002</code>.</p>"
            + table(rows, ["Code", "Field", "Label", "Unit", "Scope", "Class", "Tokens"], cls="t dense", key="tbl-inputs", caption="HK001 input codes",
                    widths=["8%", "13%", "33%", "11%", "8%", "10%", "17%"]))


STAGE = {"EQ": "Equation", "ML": "Master Law", "X8S": "X8S", "SP8": "8Sphere", "SUM": "Receipt"}


def gen_codes(d):
    st = d.get("stats") or {}
    summary = [(STAGE.get(k.split(":")[0], k.split(":")[0]), k.split(":")[1], str(v)) for k, v in sorted(st.items())]
    rows = [(f"<code>{esc(c['code'])}</code>", STAGE.get(c["stage"], c["stage"]), esc(c["family"]), esc(c["label"]), "●" if c["published"] else "") for c in d["catalog"]]
    return ("<h1>HK001 computation codes</h1>"
            f"<p>Every node of the HK001 2.3.0 computation graph has a code, and every code is a command: {len(d['catalog'])} in all "
            "(generated from <code>rink/hk001/catalog.js</code>). A code prints its formula, its labelled inputs with values and provenance, "
            "its value, bounds and disposition, its dependents, and the plate of the Mathematical Corpus that states it. The dot marks the "
            "published models; the rest are the traced intermediates the published models are computed from.</p>"
            + table(summary, ["Stage", "Kind", "Codes"], key="tbl-code-summary", caption="Computation codes by stage", widths=["40%", "40%", "20%"])
            + table(rows, ["Code", "Stage", "Family", "Label", "Pub."], cls="t dense", key="tbl-codes", caption="HK001 computation codes",
                    widths=["16%", "11%", "20%", "47%", "6%"]))


def gen_contracts(recs, ja):
    rows = [(f"<code>{esc(r['file'])}</code>", f"<code>{esc(r['module'])}</code>", str(r["rules"]), f"<code class=wrap>{esc(r['kappa'])}</code>") for r in recs]
    q = next((r for r in recs if r["file"].startswith("90_")), None)
    qrows = [(f"<code>{esc(k)}</code>", esc(json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v)) for k, v in (q["state"].items() if q else [])]
    out = ("<h1>Contract listings</h1>"
           "<p>The MSSL records and JA21 sources of the release, as they stand in <code>contracts/</code> when this guide was built. The seal "
           "κ of each record is the SHA-256 of its text from <code>α≡</code> up to the comma before <code>κ≡</code>; any change to a record "
           "changes its seal, and <code>tools/contracts.py check</code> refuses it.</p>"
           + table(rows, ["Record", "Module (λ)", "Rules (δ)", "Seal (κ)"], key="tbl-records", caption="MSSL records of the release", widths=["25%", "28%", "9%", "38%"]))
    if q:
        out += ("<h2>The qualification record</h2><p>The facts of <code>90_qualification.mssl</code> (its η.state), written by "
                "<code>tools/contracts.py qualify</code> from the test run that qualified this release.</p>"
                + table(qrows, ["Fact", "Value"], key="tbl-qualification", caption="Qualification of the release", widths=["18%", "82%"]))
    suite = next((r for r in recs if r["file"].startswith("00_")), None)
    if suite:
        out += "<h2>The suite identity record</h2><p>The record <code>00_suite_identity.mssl</code> in full.</p><pre class=mssl>" + esc(suite["text"]) + "</pre>"
    for j in ja:
        out += f"<h2>{esc(j['file'])}</h2><pre class=ja>" + esc(j["text"]) + "</pre>"
    return out


def gen_tests_table(tests):
    rows, last = [], None
    for t in tests:
        m = t["module"]
        what = t["doc"] or (t["method"][5:] if t["method"].startswith("test_") else t["method"]).replace("_", " ")
        what = what[:1].upper() + what[1:]
        mod = (f"<code>{esc(m)}</code><br><span class=dim>{esc(t['module_doc'])}</span>" if m != last else "")
        rows.append((mod, f"<code>{esc(t['cls'])}</code>", esc(what)))
        last = m
    return table(rows, ["Module", "Class", "Test"], cls="t dense", key="tbl-test-inventory", caption="The edition's tests", widths=["30%", "16%", "54%"])


# ---- composition ---------------------------------------------------------------------------------------------
class Doc:
    def __init__(self, gen):
        self.gen = gen
        self.toc = []          # (level, number, title, id)
        self.tables = []       # (number, caption, id)
        self.figures = []
        self.keys = {}         # key -> (label, id)
        self.chapters = []     # (number, title, id, kind)

    def number(self, frag, label, kind):
        """Number the headings, tables and figures of one chapter or appendix."""
        sec = [0, 0]
        tcount = fcount = 0
        out = []
        pos = 0
        pat = re.compile(r'<h([123])(?: key="([^"]+)")?>(.*?)</h\1>|<table class="([^"]*)"(?: key="([^"]+)")?(?: caption="([^"]*)")?>|<figure(?: key="([^"]+)")?(?: caption="([^"]*)")?>', re.S)
        for m in pat.finditer(frag):
            out.append(frag[pos:m.start()])
            pos = m.end()
            if m.group(1):
                lvl, key, title = int(m.group(1)), m.group(2), m.group(3).strip()
                if lvl == 1:
                    hid = f"{kind}-{label}"
                    num = label
                    self.chapters.append((label, title, hid, kind))
                    self.toc.append((1, label, title, hid, kind))
                    if kind == "ch":
                        out.append(f'<h1 class="chapter" id="{hid}"><span class="cnum">Chapter {label}</span><span class="ctitle">{title}</span></h1>')
                    else:
                        out.append(f'<h1 class="chapter appendix" id="{hid}"><span class="cnum">Appendix {label}</span><span class="ctitle">{title}</span></h1>')
                    if key:
                        self.keys[key] = (f"{'Chapter' if kind == 'ch' else 'Appendix'} {label}", hid)
                    continue
                if lvl == 2:
                    sec = [sec[0] + 1, 0]
                    num = f"{label}.{sec[0]}"
                else:
                    sec[1] += 1
                    num = f"{label}.{sec[0]}.{sec[1]}"
                hid = "sec-" + num.replace(".", "-")
                if lvl == 2:
                    self.toc.append((2, num, title, hid, kind))
                if key:
                    self.keys[key] = (f"§{num}", hid)
                out.append(f'<h{lvl} id="{hid}"><span class="snum">{num}</span>{title}</h{lvl}>')
            elif m.group(4) is not None:
                cls, key, cap = m.group(4), m.group(5), m.group(6)
                if cap:
                    tcount += 1
                    num = f"{label}-{tcount}"
                    tid = f"tbl-{num}"
                    self.tables.append((num, html.unescape(cap), tid))
                    if key:
                        self.keys[key] = (f"Table {num}", tid)
                    out.append(f'<table class="{cls}" id="{tid}"><caption><span class="tlabel">Table {num}</span>{cap}</caption>')
                else:
                    out.append(f'<table class="{cls}">')
            else:
                key, cap = m.group(7), m.group(8)
                fcount += 1
                num = f"{label}-{fcount}"
                fid = f"fig-{num}"
                self.figures.append((num, html.unescape(cap or ""), fid))
                if key:
                    self.keys[key] = (f"Figure {num}", fid)
                out.append(f'<figure id="{fid}" data-caption="Figure {num}. {cap or ""}">')
        out.append(frag[pos:])
        text = "".join(out)
        # captions of figures go under them
        text = re.sub(r'<figure id="([^"]+)" data-caption="([^"]*)">(.*?)</figure>',
                      lambda m: f'<figure id="{m.group(1)}">{m.group(3)}<figcaption>{m.group(2).replace("Figure ", "<span class=tlabel>Figure ", 1).replace(". ", "</span>", 1)}</figcaption></figure>', text, flags=re.S)
        return text


def toc_html(doc, pages):
    def pg(hid):
        return pages.get(hid, "000") if pages else "000"
    rows = [f'<li class="tfm"><a href="#{hid}"><span class="tt">{t}</span><span class="tp">{pg(hid)}</span></a></li>'
            for hid, t in (("control", "Document control"), ("notices", "Notices"), ("conventions", "Conventions"), ("lists", "Figures and tables"))]
    for lvl, num, title, hid, kind in doc.toc:
        if lvl == 0:
            rows.append(f'<li class="tpart"><a href="#{hid}"><span class="tt">Part {num} · {title}</span><span class="tp">{pg(hid)}</span></a></li>')
        elif lvl == 1:
            lab = num if kind == "ch" else f"Appendix {num}"
            rows.append(f'<li class="tch"><a href="#{hid}"><span class="tn">{lab}</span><span class="tt">{title}</span><span class="tp">{pg(hid)}</span></a></li>')
        else:
            rows.append(f'<li class="tsec"><a href="#{hid}"><span class="tn">{num}</span><span class="tt">{title}</span><span class="tp">{pg(hid)}</span></a></li>')
    return '<ol class="toc">' + "".join(rows) + "</ol>"


def lot_html(doc, pages):
    def pg(hid):
        return pages.get(hid, "000") if pages else "000"
    t = "".join(f'<li><a href="#{tid}"><span class="tn">{num}</span><span class="tt">{esc(cap)}</span><span class="tp">{pg(tid)}</span></a></li>' for num, cap, tid in doc.tables)
    f = "".join(f'<li><a href="#{fid}"><span class="tn">{num}</span><span class="tt">{esc(cap)}</span><span class="tp">{pg(fid)}</span></a></li>' for num, cap, fid in doc.figures)
    return f'<h2 class="fm" id="lof">Figures</h2><ol class="lot">{f}</ol><h2 class="fm" id="lot">Tables</h2><ol class="lot">{t}</ol>'


def compose(gen, pages=None):
    doc = Doc(gen)
    body = []
    n = 0
    for pnum, ptitle, chs in PARTS:
        pid = f"part-{pnum}"
        doc.toc.append((0, pnum, ptitle, pid, "part"))
        intro = gen["part_intro"].get(pnum, "")
        body.append(f'<section class="partpage" id="{pid}"><div class="pnum">Part {pnum}</div><div class="ptitle">{ptitle}</div><div class="pintro">{intro}</div></section>')
        for ch in chs:
            n += 1
            frag = read(HG, "chapters", ch + ".html")
            frag = frag.replace("{{tests_table}}", gen["tests_table"])
            body.append(f'<section class="chap">{doc.number(frag, str(n), "ch")}</section>')
    for label, src in APPENDICES:
        frag = gen[src] if src.startswith("gen:") else read(HG, "chapters", src + ".html")
        body.append(f'<section class="chap app">{doc.number(frag, label, "ap")}</section>')
    front = []
    for f in FRONT:
        frag = read(HG, "chapters", f + ".html")
        front.append(frag)
    text = "".join(body)

    def ref(m):
        k = m.group(1)
        if k not in doc.keys:
            raise SystemExit(f"handguide: unknown reference {{{{ref:{k}}}}}")
        lab, hid = doc.keys[k]
        return f'<a class="xref" href="#{hid}">{lab}</a>'
    text = re.sub(r"\{\{ref:([a-z0-9-]+)\}\}", ref, text)
    fm = re.sub(r"\{\{ref:([a-z0-9-]+)\}\}", ref, "".join(front))
    for k, v in gen["vars"].items():
        text = text.replace("{{" + k + "}}", v)
        fm = fm.replace("{{" + k + "}}", v)
    left = re.findall(r"\{\{[a-z_:]+\}\}", text + fm)
    if left:
        raise SystemExit(f"handguide: unresolved placeholders {sorted(set(left))[:8]}")
    css = read(HG, "handguide.css")
    cover = read(HG, "chapters", "cover.html")
    for k, v in gen["vars"].items():
        cover = cover.replace("{{" + k + "}}", v)
    page = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{esc(TITLE)}</title><style>{css}</style></head><body>'
            f'{cover}<section class="front">{fm}<section class="fmblock" id="contents"><h1 class="fmh">Contents</h1>{toc_html(doc, pages)}</section>'
            f'<section class="fmblock" id="lists"><h1 class="fmh">Figures and tables</h1>{lot_html(doc, pages)}</section></section>'
            f'<main>{text}</main></body></html>')
    return page, doc


# ---- printing ------------------------------------------------------------------------------------------------
def roman(n):
    out = ""
    for v, s in ((1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")):
        while n >= v:
            out += s
            n -= v
    return out


def print_pdf(browser, page_html):
    pg = browser.new_page()
    pg.set_content(page_html, wait_until="load")
    pg.evaluate("document.fonts.ready.then(() => true)")
    data = pg.pdf(format="Letter", print_background=True, prefer_css_page_size=True, tagged=True, outline=False)
    pg.close()
    return data


def destinations(pdf_bytes):
    from pypdf import PdfReader
    r = PdfReader(io.BytesIO(pdf_bytes))
    return {k.lstrip("/"): r.get_destination_page_number(v) for k, v in r.named_destinations.items()}, len(r.pages)


def chrome_html(n_pages, first_body, chapters, dests, total_body):
    """One overlay page per document page: the running header, the rule and the footer."""
    starts = sorted(((dests[c[2]], c) for c in chapters if c[2] in dests), key=lambda x: x[0])
    parts = {dests[f"part-{p[0]}"] for p in PARTS if f"part-{p[0]}" in dests}
    css = """@page { size: Letter; margin: 0 } * { margin: 0; padding: 0 } body { font-family: Carlito, 'DejaVu Sans', FreeSans, sans-serif; color: #2d3a55 }
    .pg { width: 8.5in; height: 11in; position: relative; break-after: page; overflow: hidden }
    .hd { position: absolute; top: 0.48in; left: 0.95in; right: 0.95in; display: flex; justify-content: space-between; font-size: 7.6pt; letter-spacing: .02em;
          border-bottom: 0.6pt solid #b7c0cf; padding-bottom: 3.5pt }
    .hd b { font-weight: 600; color: #1d2b4f }
    .ft { position: absolute; bottom: 0.42in; left: 0.95in; right: 0.95in; display: flex; justify-content: space-between; font-size: 7.4pt; color: #56627a;
          border-top: 0.6pt solid #b7c0cf; padding-top: 3.5pt }
    .ft .cls { letter-spacing: .14em; font-weight: 600; color: #1d2b4f } .ft .pn { font-weight: 600; color: #1d2b4f }"""
    pages = []
    issued = ISSUED.strftime("%d %B %Y").lstrip("0")
    for p in range(n_pages):
        if p == 0:
            pages.append('<div class="pg"></div>')
            continue
        if p < first_body:
            label, right = roman(p + 1), "Front matter"
            pn = f"Page {label}"
        else:
            num = p - first_body + 1
            pn = f"Page {num} of {total_body}"
            cur = None
            for s, c in starts:
                if s <= p:
                    cur = c
            right = (f"Chapter {cur[0]} · {cur[1]}" if cur[3] == "ch" else f"Appendix {cur[0]} · {cur[1]}") if cur else ""
            if p in parts:
                right = ""
        hd = f'<div class="hd"><span><b>RINK-VT Workbench</b> · Technical Handguide</span><span>{esc(right)}</span></div>' if right else ""
        ft = f'<div class="ft"><span>{DOC_ID} · Revision {REVISION} · {issued}</span><span class="cls">UNRESTRICTED · PUBLIC</span><span class="pn">{pn}</span></div>'
        pages.append(f'<div class="pg">{hd}{ft}</div>')
    return f'<!doctype html><html lang="en"><head><meta charset="utf-8"><style>{css}</style></head><body>{"".join(pages)}</body></html>'


def finish(content_pdf, overlay_pdf, doc, dests, first_body, out):
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(io.BytesIO(content_pdf))
    over = PdfReader(io.BytesIO(overlay_pdf))
    w = PdfWriter(clone_from=reader)
    for i, page in enumerate(w.pages):
        if i > 0:
            page.merge_page(over.pages[i], over=True)
            page.compress_content_streams(level=9)      # merging leaves the joined content uncompressed
    w.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)   # the overlay's fonts, once
    n = len(w.pages)
    w.set_page_label(0, first_body - 1, style="/r", start=1)
    w.set_page_label(first_body, n - 1, style="/D", start=1)
    # bookmarks: front matter, parts > chapters > sections, appendices > sections
    w.add_outline_item("Cover", 0)
    for hid, title in (("control", "Document control"), ("notices", "Notices"), ("conventions", "Conventions"), ("contents", "Contents"), ("lists", "Figures and tables")):
        if hid in dests:
            w.add_outline_item(title, dests[hid])
    part_item = chap_item = None
    app_root = None
    for lvl, num, title, hid, kind in doc.toc:
        if hid not in dests:
            continue
        t = html.unescape(re.sub(r"<[^>]+>", "", title))
        if lvl == 0:
            part_item = w.add_outline_item(f"Part {num} · {t}", dests[hid])
        elif lvl == 1:
            if kind == "ap":
                if app_root is None:
                    app_root = w.add_outline_item("Appendices", dests[hid])
                chap_item = w.add_outline_item(f"Appendix {num} · {t}", dests[hid], parent=app_root)
            else:
                chap_item = w.add_outline_item(f"{num} {t}", dests[hid], parent=part_item)
        else:
            w.add_outline_item(f"{num} {t}", dests[hid], parent=chap_item)
    w.page_mode = "/UseOutlines"
    w.create_viewer_preferences()
    w.viewer_preferences.display_doctitle = True
    w.add_metadata({
        "/Title": TITLE,
        "/Author": "RUSSELL PHILIP SMITHSON",
        "/Subject": f"Operating, technical and assurance manual for RINK-VT {VERSION} (LK/Vexa edition, Photon-hosted) and {REFERENCE} (reference edition)",
        "/Keywords": "RINK-VT, LK/Vexa, Photon, MSSL, JA21, hockey statistics, HERMIT, loopback leases, ledger, HK001",
        "/Creator": "docs/handguide/build.py (Chromium, pypdf)",
        "/Producer": "pypdf",
        "/CreationDate": "D:" + ISSUED.strftime("%Y%m%d") + "120000Z",
    })
    with open(out, "wb") as f:
        w.write(f)
    return n


def gather(browser):
    eng = extract_engine(browser)
    tests = test_inventory()
    recs, ja = contract_files()
    mods = {}
    for t in tests:
        mods.setdefault(t["module"], 0)
        mods[t["module"]] += 1
    q = next((r["state"] for r in recs if r["file"].startswith("90_")), {})
    gen = {
        "gen:commands": gen_commands(eng), "gen:tokens": gen_tokens(eng), "gen:queries": gen_queries(eng),
        "gen:inputs": gen_inputs(eng), "gen:codes": gen_codes(eng), "gen:contracts": gen_contracts(recs, ja),
        "tests_table": gen_tests_table(tests),
        "part_intro": {
            "I": "What the workbench is, who this guide is for, and how to start it.",
            "II": "How to run the Photon host and the workbench, score games, keep rosters, and keep the league safe.",
            "III": "The architecture, the formats on disk and on the wire, the host's API, the engine's rules and models, and the security model.",
            "IV": "How a release is verified, what its tests cover, what its contracts state, and where its limits lie.",
            "V": "The HERMIT gateway on Node.js: the multi-user edition the engine comes from.",
        },
        "vars": {
            "version": VERSION, "engine": ENGINE, "reference": REFERENCE, "doc_id": DOC_ID, "revision": REVISION,
            "issued": ISSUED.strftime("%d %B %Y").lstrip("0"), "n_codes": str(len(eng["catalog"])), "n_inputs": str(len(eng["inputs"])),
            "n_tokens": str(len(eng["tokens"])), "n_tests": str(len(tests)), "n_test_modules": str(len(mods)),
            "n_records": str(len(recs)), "n_ja": str(len(ja)), "n_commands": str(len(eng["commands"])), "n_code_commands": str(eng["codeCommands"]),
            "q_result": esc(q.get("result", "not yet qualified")), "q_checks": esc(q.get("checks", "—")), "q_passed": esc(q.get("passed", "—")),
            "q_skipped": esc(q.get("skipped", "—")), "q_platform": esc(q.get("platform", "—")), "q_scope": esc(q.get("scope_limit", "—")),
            "q_run_at": esc(q.get("run_at", "—")), "chromium": esc(browser.version),
        },
    }
    return gen


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HG, "RINK-VT_Handguide.pdf"))
    ap.add_argument("--html", default=None, help="also write the composed HTML (for review)")
    ns = ap.parse_args(argv)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        gen = gather(browser)
        pages = None
        for attempt in range(4):
            page_html, doc = compose(gen, pages)
            pdf = print_pdf(browser, page_html)
            dests, n = destinations(pdf)
            first_body = dests["part-I"]
            labels = {hid: (str(pg - first_body + 1) if pg >= first_body else roman(pg + 1)) for hid, pg in dests.items()}
            if labels == pages:
                break
            pages = labels
        else:
            raise SystemExit("handguide: the page numbers did not settle")
        if ns.html:
            with open(ns.html, "w", encoding="utf-8") as f:
                f.write(page_html)
        total_body = n - first_body
        overlay = print_pdf(browser, chrome_html(n, first_body, doc.chapters, dests, total_body))
        browser.close()
    count = finish(pdf, overlay, doc, dests, first_body, ns.out)
    print(f"{os.path.relpath(ns.out, ROOT)}: {count} pages ({first_body} front matter, {total_body} body) · "
          f"{len(doc.tables)} tables · {len(doc.figures)} figures · {attempt + 1} passes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
