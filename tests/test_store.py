# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The league store: what is acknowledged is on disk, sealed and chained; nothing else is accepted."""
import json
import os
import unittest

from helpers import b64, engine_fixture, new_uuid, pairs, registry, tempdir

from host.store import LeagueStore, StoreError


def commit(store, games, reg=True, base="current", ledgers=()):
    return store.commit(registry=registry(games) if reg else None, base=store.registry_sha if base == "current" else base, ledgers=list(ledgers))


class Commit(unittest.TestCase):
    def setUp(self):
        self.dir = tempdir(self)
        self.s = LeagueStore(self.dir)
        self.u1 = new_uuid()
        self.games = [("G1", self.u1)]

    def test_round_trip_across_reopen(self):
        r = commit(self.s, self.games, ledgers=[{"game": "G1", "uuid": self.u1, "start": 0, "data": b64(pairs(self.u1, 0, 3))}])
        self.assertEqual(r["counts"], {"G1": 3})
        commit(self.s, self.games, reg=False, ledgers=[{"game": "G1", "uuid": self.u1, "start": 3, "data": b64(pairs(self.u1, 3, 2))}])
        again = LeagueStore(self.dir)
        index, blob = again.snapshot()
        self.assertEqual(index["games"], [{"key": "G1", "uuid": self.u1, "pairs": 5}])
        self.assertEqual(len(blob), 5 * 128)
        self.assertEqual(index["registrySha"], self.s.registry_sha)
        self.assertTrue(again.verify()["ok"])

    def test_engine_entries_accepted(self):
        game, uuid, data = engine_fixture()
        commit(self.s, [(game, uuid)], ledgers=[{"game": game, "uuid": uuid, "start": 0, "data": b64(data)}])
        self.assertEqual(LeagueStore(self.dir).snapshot()[0]["games"][0]["pairs"], len(data) // 128)

    def test_stale_base_refused(self):
        commit(self.s, self.games)
        with self.assertRaises(StoreError) as e:
            commit(self.s, self.games + [("G2", new_uuid())], base=None)
        self.assertEqual(e.exception.code, "CONFLICT")

    def test_start_must_be_the_end(self):
        commit(self.s, self.games, ledgers=[{"game": "G1", "uuid": self.u1, "start": 0, "data": b64(pairs(self.u1, 0, 2))}])
        for start in (0, 1, 3):
            with self.assertRaises(StoreError) as e:
                commit(self.s, self.games, reg=False, ledgers=[{"game": "G1", "uuid": self.u1, "start": start, "data": b64(pairs(self.u1, 2, 1))}])
            self.assertEqual(e.exception.code, "CONFLICT")

    def test_games_are_never_removed(self):
        commit(self.s, self.games)
        with self.assertRaises(StoreError) as e:
            commit(self.s, [("G2", new_uuid())])
        self.assertEqual(e.exception.code, "CONFLICT")

    def test_bad_entries_refused_and_nothing_written(self):
        commit(self.s, self.games)
        good = pairs(self.u1, 0, 2)
        bad_crc = bytearray(good); bad_crc[10] ^= 1
        other_game = pairs(new_uuid(), 0, 1)
        bad_meta = bytearray(good); bad_meta[64 + 20] ^= 1
        for data, why in ((bytes(bad_crc), "frame CRC"), (other_game, "game hash"), (bytes(bad_meta), "meta CRC"), (good[:100], "half a pair")):
            with self.assertRaises(StoreError, msg=why):
                commit(self.s, self.games, reg=False, ledgers=[{"game": "G1", "uuid": self.u1, "start": 0, "data": b64(data)}])
        self.assertEqual(self.s.snapshot()[0]["games"][0]["pairs"], 0)
        with self.assertRaises(StoreError):
            commit(self.s, self.games, reg=False, ledgers=[{"game": "G1", "uuid": self.u1, "start": 0, "data": "@@not base64@@"}])

    def test_unknown_game_refused(self):
        commit(self.s, self.games)
        with self.assertRaises(StoreError) as e:
            u = new_uuid()
            commit(self.s, self.games, reg=False, ledgers=[{"game": "G9", "uuid": u, "start": 0, "data": b64(pairs(u, 0, 1))}])
        self.assertEqual(e.exception.code, "BAD_REQUEST")

    def test_registry_checks(self):
        for text in ("[]", '{"schema":"other"}', '{"schema":"rinkvt.registry.v1","teams":[],"players":[],"games":[{"key":"G1"}],"notes":[]}',
                     '{"schema":"rinkvt.registry.v1","teams":[],"players":[],"games":[],"notes":[],"a":1,"a":2}', "{bad json"):
            with self.assertRaises(StoreError, msg=text):
                self.s.commit(registry=text, base=None)

    def test_event_ledger_records_commits(self):
        commit(self.s, self.games, ledgers=[{"game": "G1", "uuid": self.u1, "start": 0, "data": b64(pairs(self.u1, 0, 1))}])
        with open(os.path.join(self.dir, "events.jsonl"), encoding="utf-8") as f:
            ev = [json.loads(line) for line in f]
        self.assertEqual(ev[-1]["event"], "commit")
        self.assertEqual(ev[-1]["detail"], {"registry": True, "pairs": 1, "games": ["G1"]})


class Damage(unittest.TestCase):
    def setUp(self):
        self.dir = tempdir(self)
        s = LeagueStore(self.dir)
        self.u1 = new_uuid()
        commit(s, [("G1", self.u1)], ledgers=[{"game": "G1", "uuid": self.u1, "start": 0, "data": b64(pairs(self.u1, 0, 4))}])
        self.ledger = os.path.join(self.dir, "league", "ledger", f"G1-{self.u1[:8]}.jsonl")
        self.reg = os.path.join(self.dir, "league", "registry", "registry.json")

    def _edit(self, path, fn):
        with open(path, "rb") as f:
            raw = f.read()
        with open(path, "wb") as f:
            f.write(fn(raw))

    def test_torn_last_line_dropped_on_open(self):
        self._edit(self.ledger, lambda raw: raw + b'{"n":4,"frame":"00')
        s = LeagueStore(self.dir)                                    # opening drops the unacknowledged line
        self.assertEqual(s.snapshot()[0]["games"][0]["pairs"], 4)
        self.assertIn("G1", s.recovered)
        with open(self.ledger, "rb") as f:
            self.assertTrue(f.read().endswith(b"\n"))
        self.assertTrue(s.verify()["ok"])

    def test_verify_does_not_repair(self):
        s = LeagueStore(self.dir)
        self._edit(self.ledger, lambda raw: raw + b'{"n":4')
        report = s.verify()
        self.assertFalse(report["ok"])
        self.assertIn("unfinished line", report["games"][0]["error"])
        with open(self.ledger, "rb") as f:
            self.assertTrue(f.read().endswith(b'{"n":4'))

    def test_edited_entry_refused(self):
        def flip(raw):
            lines = raw.split(b"\n")
            r = json.loads(lines[2])
            r["frame"] = ("0" if r["frame"][0] != "0" else "1") + r["frame"][1:]
            lines[2] = json.dumps(r, separators=(",", ":")).encode()
            return b"\n".join(lines)
        self._edit(self.ledger, flip)
        with self.assertRaises(StoreError) as e:
            LeagueStore(self.dir)
        self.assertEqual(e.exception.code, "DAMAGED")

    def test_removed_line_refused(self):
        self._edit(self.ledger, lambda raw: b"\n".join(raw.split(b"\n")[:2] + raw.split(b"\n")[3:]))
        with self.assertRaises(StoreError):
            LeagueStore(self.dir)

    def test_edited_registry_refused(self):
        self._edit(self.reg, lambda raw: raw.replace(b'"seq": 1', b'"seq": 2'))
        with self.assertRaises(StoreError) as e:
            LeagueStore(self.dir)
        self.assertEqual(e.exception.code, "DAMAGED")

    def test_commit_cut_off_before_its_rename(self):
        # the stop fell after the new seal and the new text were written, before the text was renamed into place
        reg_dir = os.path.dirname(self.reg)
        with open(os.path.join(reg_dir, "registry.sha256.new"), "w", encoding="utf-8") as f:
            f.write("0" * 64 + "  registry.json\n")
        with open(os.path.join(reg_dir, "registry.json.4242.tmp"), "w", encoding="utf-8") as f:
            f.write("{}")
        s = LeagueStore(self.dir)                                    # the old registry stands; the leftovers go
        self.assertEqual(len(s.snapshot()[0]["games"]), 1)
        self.assertEqual(sorted(os.listdir(reg_dir)), ["registry.json", "registry.sha256"])

    def test_interrupted_seal_completed_on_open(self):
        # the stop fell between writing registry.json and renaming its new seal into place
        reg_dir = os.path.dirname(self.reg)
        s = LeagueStore(self.dir)
        new_text = registry([("G1", self.u1), ("G2", new_uuid())])
        import hashlib
        with open(os.path.join(reg_dir, "registry.sha256.new"), "w", encoding="utf-8") as f:
            f.write(hashlib.sha256(new_text.encode()).hexdigest() + "  registry.json\n")
        with open(self.reg, "w", encoding="utf-8", newline="") as f:
            f.write(new_text)
        report = s.verify()
        self.assertFalse(report["ok"])                               # verification reports and leaves it
        again = LeagueStore(self.dir)                                # opening completes the commit
        self.assertEqual(len(again.snapshot()[0]["games"]), 2)
        self.assertFalse(os.path.exists(os.path.join(reg_dir, "registry.sha256.new")))


if __name__ == "__main__":
    unittest.main()
