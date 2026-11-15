# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The Photon host's loopback API: its guards, its headers and its commit round trip."""
import json
import unittest

from helpers import RunningHost, b64, new_uuid, pairs, registry, tempdir

from host.server import CSP, MAX_BODY


class Guards(unittest.TestCase):
    def setUp(self):
        self.h = RunningHost(tempdir(self))
        self.addCleanup(self.h.close)

    def test_health_and_page(self):
        status, hdrs, body = self.h.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        status, hdrs, body = self.h.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(self.h.token.encode(), body)                   # the page carries this launch's token
        self.assertNotIn(b"__RINKVT_", body)
        self.assertEqual(hdrs["Content-Security-Policy"], CSP)
        for k in ("X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Cross-Origin-Opener-Policy", "Cache-Control"):
            self.assertIn(k, hdrs)

    def test_host_header_guard(self):
        for host in ("evil.example", f"evil.example:{self.h.port}", "127.0.0.1", f"127.0.0.2:{self.h.port}", f"127.0.0.1:{self.h.port + 1}", ""):
            status, _, body = self.h.request("GET", "/api/health", headers={"Host": host})
            self.assertEqual(status, 421, host)
        self.assertEqual(self.h.request("GET", "/api/health", headers={"Host": f"localhost:{self.h.port}"})[0], 200)

    def test_token_guard(self):
        for tok in (None, "", "x", self.h.token + "x", self.h.token.upper()):
            hdr = {} if tok is None else {"X-VEC1-Token": tok}
            status, _, _ = self.h.request("GET", "/api/league", headers=hdr)
            self.assertEqual(status, 403, tok)

    def test_mutation_guards(self):
        body = {"base": None, "registry": registry([])}
        tok = {"X-VEC1-Token": self.h.token}
        status, _, _ = self.h.request("POST", "/api/commit", raw=json.dumps(body).encode(), headers=dict(tok, **{"Content-Type": "text/plain"}))
        self.assertEqual(status, 415)
        status, _, _ = self.h.request("POST", "/api/commit", body, headers=dict(tok, Origin="http://evil.example"))
        self.assertEqual(status, 403)
        status, _, _ = self.h.request("POST", "/api/commit", body, headers={"Origin": f"http://{self.h.host}"})
        self.assertEqual(status, 403)                                 # same origin, but no token
        status, _, _ = self.h.request("POST", "/api/commit", raw=b'{"base":null,"base":null}', headers=dict(tok, **{"Content-Type": "application/json"}))
        self.assertEqual(status, 400)                                 # duplicate keys
        status, _, _ = self.h.request("POST", "/api/commit", raw=b"[]", headers=dict(tok, **{"Content-Type": "application/json"}))
        self.assertEqual(status, 400)
        status, _, _ = self.h.request("POST", "/api/commit", raw=b"{}", headers=dict(tok, **{"Content-Type": "application/json", "Content-Length": str(MAX_BODY + 1)}))
        self.assertEqual(status, 413)

    def test_deep_nesting_is_a_bad_request(self):
        tok = {"X-VEC1-Token": self.h.token, "Content-Type": "application/json"}
        for raw in (b"[" * 100000 + b"]" * 100000, b'{"a":' * 70 + b"1" + b"}" * 70):
            status, _, _ = self.h.request("POST", "/api/commit", raw=raw, headers=tok)
            self.assertEqual(status, 400)

    def test_static_files_only(self):
        for path in ("/workbench.js", "/workbench.css"):
            self.assertEqual(self.h.request("GET", path)[0], 200, path)
        for path in ("/../photon/rinkvt.py", "/ui/app.js", "/RELEASE_MANIFEST.json", "/%2e%2e/LICENSE", "/api/nothing"):
            status = self.h.request("GET", path, headers={"X-VEC1-Token": self.h.token})[0]
            self.assertIn(status, (403, 404), path)


class RoundTrip(unittest.TestCase):
    def setUp(self):
        self.h = RunningHost(tempdir(self))
        self.addCleanup(self.h.close)

    def test_commit_league_ledgers_verify(self):
        u = new_uuid()
        status, r = self.h.api("POST", "/api/commit", {"base": None, "registry": registry([("G1", u)]),
                                                       "ledgers": [{"game": "G1", "uuid": u, "start": 0, "data": b64(pairs(u, 0, 3))}]})
        self.assertEqual(status, 200, r)
        sha = r["registrySha"]
        status, lg = self.h.api("GET", "/api/league")
        self.assertEqual(status, 200)
        self.assertEqual(lg["registrySha"], sha)
        self.assertEqual(lg["games"], [{"key": "G1", "uuid": u, "pairs": 3}])
        status, _, blob = self.h.request("GET", f"/api/ledgers?sha={sha}", headers={"X-VEC1-Token": self.h.token})
        self.assertEqual((status, len(blob)), (200, 3 * 128))
        status, _, _ = self.h.request("GET", "/api/ledgers?sha=stale", headers={"X-VEC1-Token": self.h.token})
        self.assertEqual(status, 409)
        status, r = self.h.api("POST", "/api/commit", {"base": "stale", "ledgers": []})
        self.assertEqual(status, 409)
        status, v = self.h.api("GET", "/api/verify")
        self.assertTrue(v["ok"], v)
        status, ed = self.h.api("GET", "/api/edition")
        self.assertEqual(ed["product"], "RINK-VT")
        self.assertIn("no Node.js", ed["runtime"])


if __name__ == "__main__":
    unittest.main()
