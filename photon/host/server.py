# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The Photon host's loopback JSON API and the renderer's files.

Guards, in the VEC1 Photon manner: the Host header must name this listener exactly (DNS rebinding), every /api call
except /api/health carries the per-launch token in X-VEC1-Token, a state-changing call must be same-origin JSON, bodies
have a length and a ceiling, and the page is served with a CSP that allows nothing but this origin.

  GET  /                  the workbench (the token and this computer's loopback lease are written into it)
  GET  /workbench.js .css the engine bundle and its styles
  GET  /api/health        {ok, version}
  GET  /api/edition       product, edition, versions, runtime, this computer's address and loopback lease
  GET  /api/league        the registry text and its seal, and each game's number of ledger pairs
  GET  /api/ledgers?sha=  every game's pairs, 128 bytes each, in the order /api/league lists them
  GET  /api/verify        everything re-read from disk and checked
  POST /api/commit        {registry?, base, ledgers:[{game, uuid, start, data}]}: recorded before the answer
  POST /api/shutdown      stop the host
"""
import hmac
import json
import platform
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import EDITION, ENGINE, PRODUCT, VERSION, strictjson
from .store import StoreError

TOKEN_HEADER = "X-VEC1-Token"
MAX_BODY = 32 * 1024 * 1024
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
STATIC = {"/workbench.js": ("workbench.js", "text/javascript; charset=utf-8"), "/workbench.css": ("workbench.css", "text/css; charset=utf-8")}


class HttpError(Exception):
    def __init__(self, status, error, detail=""):
        super().__init__(detail)
        self.status, self.error, self.detail = status, error, detail


class PhotonHost(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, addr, handler, *, store, token, ui_dir, info):
        super().__init__(addr, handler)
        self.store, self.token, self.ui_dir, self.info = store, token, Path(ui_dir), info
        host, port = self.server_address[0], self.server_address[1]
        self.allowed_hosts = {f"{host}:{port}"} | ({f"localhost:{port}"} if host == "127.0.0.1" else set())
        self.allowed_origins = {f"http://{h}" for h in self.allowed_hosts}


class Handler(BaseHTTPRequestHandler):
    server_version = f"RINK-VT-Photon/{VERSION}"
    sys_version = ""
    timeout = 60

    def log_message(self, fmt, *args):
        pass                                        # the host's own event ledger records what matters

    def _headers(self, status=200, ctype="application/json; charset=utf-8", length=None, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if length is not None:
            self.send_header("Content-Length", str(length))
        for k, v in (("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
                     ("X-Frame-Options", "DENY"), ("Cross-Origin-Opener-Policy", "same-origin"), ("Cross-Origin-Resource-Policy", "same-origin"),
                     ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=()"), ("Content-Security-Policy", CSP)):
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _json(self, obj, status=200):
        data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        self._headers(status, length=len(data))
        if self.command != "HEAD":
            self.wfile.write(data)

    def _bytes(self, data, ctype):
        self._headers(200, ctype, len(data))
        if self.command != "HEAD":
            self.wfile.write(data)

    # ---- guards ---------------------------------------------------------------------------------------------
    def _guard_host(self):
        if (self.headers.get("Host") or "").strip().lower() not in self.server.allowed_hosts:
            raise HttpError(421, "misdirected request", "the Host header does not name this loopback host")

    def _guard_token(self):
        if not hmac.compare_digest((self.headers.get(TOKEN_HEADER) or "").encode(), self.server.token.encode()):
            raise HttpError(403, "forbidden", f"missing or invalid {TOKEN_HEADER}")

    def _guard_mutation(self):
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self.server.allowed_origins:
            raise HttpError(403, "forbidden", "cross-origin request refused")
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            raise HttpError(415, "unsupported media type", "Content-Type must be application/json")
        self._guard_token()

    def _read_json(self):
        if self.headers.get("Transfer-Encoding"):
            raise HttpError(411, "length required", "chunked bodies are not accepted")
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            raise HttpError(400, "bad request", "invalid Content-Length")
        if n < 0 or n > MAX_BODY:
            raise HttpError(413, "payload too large", f"at most {MAX_BODY} bytes")
        raw = self.rfile.read(n)
        if len(raw) != n:
            raise HttpError(400, "bad request", "the body ended early")
        body = strictjson.loads(raw) if raw else {}
        if not isinstance(body, dict):
            raise HttpError(400, "bad request", "the body must be a JSON object")
        return body

    # ---- routes ---------------------------------------------------------------------------------------------
    def _dispatch(self, fn):
        try:
            self._guard_host()
            fn()
        except HttpError as e:
            self._json({"error": e.error, "detail": e.detail}, e.status)
        except StoreError as e:
            status = {"CONFLICT": 409, "TOO_LARGE": 413, "DAMAGED": 500}.get(e.code, 400)
            self._json({"error": e.code.lower(), "detail": str(e)}, status)
        except (ValueError, TypeError, UnicodeDecodeError, RecursionError) as e:
            self._json({"error": "bad request", "detail": str(e)[:300] or type(e).__name__}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:                      # noqa: BLE001 — answer, record, keep serving
            self.server.store.events.add("internal_error", where=self.path[:80], error=type(e).__name__)
            self._json({"error": "internal error", "detail": type(e).__name__}, 500)

    def _page(self):
        page = (self.server.ui_dir / "workbench.html").read_bytes()
        info = self.server.info
        for k, v in (("__RINKVT_TOKEN__", self.server.token), ("__RINKVT_LOCAL__", info["local"]), ("__RINKVT_CLIENT__", info["client"])):
            page = page.replace(k.encode(), v.encode())
        self._bytes(page, "text/html; charset=utf-8")

    def _get(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        if p in ("/", "/index.html"):
            return self._page()
        if p in STATIC:
            name, ctype = STATIC[p]
            return self._bytes((self.server.ui_dir / name).read_bytes(), ctype)
        if p == "/api/health":
            return self._json({"ok": True, "version": VERSION})
        if not p.startswith("/api/"):
            raise HttpError(404, "not found")
        self._guard_token()
        store = self.server.store
        if p == "/api/edition":
            return self._json(dict(self.server.info, product=PRODUCT, edition=EDITION, version=VERSION, engine=ENGINE,
                                   runtime=f"Photon host · Python {platform.python_version()} · no Node.js", events=store.events.seq, recovered=store.recovered))
        if p == "/api/league":
            return self._json(store.snapshot()[0])
        if p == "/api/ledgers":
            index, blob = store.snapshot()
            want = urllib.parse.parse_qs(u.query).get("sha", [""])[0] or None
            if want != index["registrySha"]:
                raise HttpError(409, "conflict", "the league changed since /api/league; ask again")
            return self._bytes(blob, "application/octet-stream")
        if p == "/api/verify":
            return self._json(store.verify())
        raise HttpError(404, "not found")

    def _post(self):
        self._guard_mutation()
        p = urllib.parse.urlparse(self.path).path
        body = self._read_json()
        if p == "/api/commit":
            reg = body.get("registry")
            if reg is not None and not isinstance(reg, str):
                raise HttpError(400, "bad request", "registry must be the registry.json text")
            led = body.get("ledgers", [])
            if not isinstance(led, list) or not all(isinstance(x, dict) for x in led):
                raise HttpError(400, "bad request", "ledgers must be a list of batches")
            return self._json(self.server.store.commit(registry=reg, base=body.get("base"), ledgers=led))
        if p == "/api/shutdown":
            self._json({"ok": True, "detail": "the Photon host is stopping"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        raise HttpError(404, "not found")

    def do_GET(self):
        self._dispatch(self._get)

    def do_HEAD(self):
        self._dispatch(self._get)

    def do_POST(self):
        self._dispatch(self._post)

    def _not_allowed(self):
        self._dispatch(lambda: (_ for _ in ()).throw(HttpError(405, "method not allowed")))

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_allowed
