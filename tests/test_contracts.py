# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The MSSL records and JA21 contracts: valid, current, and saying what the implementation does."""
import importlib.util
import os
import unittest

from helpers import ROOT

spec = importlib.util.spec_from_file_location("rinkvt_contracts", os.path.join(ROOT, "tools", "contracts.py"))
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


class Mssl(unittest.TestCase):
    def test_static_records_valid_and_current(self):
        for name, module, facts in C.contracts():
            with open(os.path.join(C.MSSL_DIR, name), "rb") as f:
                raw = f.read()
            C.validate_mssl(raw)
            self.assertEqual(raw.decode("utf-8"), C.mssl_document(f"mssl:rinkvt:lkvexa:{module.split('.')[-1]}:{C.VERSION}", module, facts), name)

    def test_the_corpus_validator_accepts_them(self):
        path = os.environ.get("RINKVT_MSSL_VERIFIER")
        if not path:
            self.skipTest("set RINKVT_MSSL_VERIFIER to the MSSL Writers Corpus tools/VERIFY_MSSL.py to run it")
        validate = C.corpus_validator(path)
        for name, _, _ in C.contracts():
            with open(os.path.join(C.MSSL_DIR, name), "rb") as f:
                validate(f.read())

    def test_validator_refuses_damage(self):
        good = C.mssl_document("mssl:test:x:1", "test.x", [("a", "b"), ("n", 3), ("list", ["x"])]).encode("utf-8")
        C.validate_mssl(good)
        for old, new in ((b'"n":3', b'"n":4'), (b"\xce\xb4\xe2\x89\xa14", b"\xce\xb4\xe2\x89\xa15"), (b'"0002"', b'"0003"'), (b"}\xe2\x87\x92\xe2\x8a\xa4", b"}")):
            bad = good.replace(old, new, 1)
            self.assertNotEqual(bad, good)
            with self.assertRaises(Exception, msg=old):
                C.validate_mssl(bad)


class Ja(unittest.TestCase):
    def test_structure(self):
        for f in C.JA_FILES:
            self.assertEqual(C.check_ja(os.path.join(C.JA_DIR, f)), [], f)

    def test_constants_match_the_implementation(self):
        self.assertEqual(C.cross_checks(), [])

    def test_checker_refuses_what_the_suite_refuses(self):
        import tempfile
        cases = {"no policy": "ja source 0.3\nmodule a.b\nuse Core\n", "braces": "ja source 0.3\nmodule a.b\npolicy no_network\nrecord A { x: Count\n",
                 "header": "module a.b\nja source 0.3\npolicy no_network\n", "stray": "ja source 0.3\nmodule a.b\npolicy no_network\nwhatever x\n"}
        for why, text in cases.items():
            with tempfile.NamedTemporaryFile("w", suffix=".ja", delete=False, encoding="utf-8") as t:
                t.write(text)
            try:
                self.assertTrue(C.check_ja(t.name), why)
            finally:
                os.remove(t.name)


if __name__ == "__main__":
    unittest.main()
