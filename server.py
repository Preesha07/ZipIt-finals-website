#!/usr/bin/env python3
"""ZipIt finals scoreboard server.

Standard library only: run `python3 server.py` and open
  http://<host>:8000/        audience display
  http://<host>:8000/admin   operator console (needs ZIPIT_ADMIN_KEY)

The server is the single source of truth. Every timer is stored as
"accumulated ms + running-since timestamp", so a browser refresh or a server
restart never loses time. Clients get pushed snapshots over Server-Sent Events
and animate the clocks locally from those timestamps.
"""

import csv
import io
import json
import mimetypes
import os
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DB_PATH = os.environ.get("ZIPIT_DB", os.path.join(ROOT, "data", "zipit.db"))
ADMIN_KEY = os.environ.get("ZIPIT_ADMIN_KEY", "zipit-admin")
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))

ROUNDS = (16, 8, 4, 2)
SIDES = ("A", "B")
DEFAULT_SETTINGS = {"matchDurationMs": 10 * 60 * 1000, "trackCheckpoints": 6}
# How far a client-supplied action timestamp may lag the server clock (network jitter).
MAX_ACTION_SKEW_MS = 2000

SCHEMA = """
create table if not exists teams (
  id integer primary key,
  name text not null unique collate nocase,
  headstart text not null default '',
  eliminated integer not null default 0,
  eliminated_round integer,
  created_at integer not null
);
create table if not exists matches (
  id integer primary key,
  round integer not null,
  team_a integer not null references teams(id),
  team_b integer not null references teams(id),
  status text not null default 'live',          -- live | done | void
  winner integer references teams(id),
  started_at integer not null,
  ended_at integer
);
create table if not exists attempts (
  id integer primary key,
  match_id integer not null references matches(id),
  team_id integer not null references teams(id),
  attempt_no integer not null,
  laps text not null,                            -- JSON list of checkpoint split times (ms)
  partial_ms integer not null,                   -- unfinished lap when the attempt ended
  checkpoints integer not null,
  score_ms integer not null,                     -- time to the last checkpoint reached
  elapsed_ms integer not null,                   -- whole attempt including the partial lap
  end_reason text not null,                      -- reset | timeout | match_end
  voided integer not null default 0,
  created_at integer not null
);
create table if not exists kv (key text primary key, value text not null);
"""


def now_ms():
    return int(time.time() * 1000)


class ActionError(Exception):
    pass


def fresh_watch(attempt_no=1):
    return {"status": "idle", "laps": [], "accum": 0, "since": None, "attemptNo": attempt_no, "lastT": 0}


def fresh_clock():
    return {"accum": 0, "since": None, "over": False}


def attempt_rank(a):
    """Sort key for attempts: more checkpoints first, then less time to reach them."""
    return (-a["checkpoints"], a["scoreMs"])


class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode=wal")
        self.db.execute("pragma foreign_keys=on")
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.settings = {**DEFAULT_SETTINGS, **self._kv("settings", {})}
        self.live = self._kv("live", None) or {"matchId": None, "clock": fresh_clock(), "sides": {s: fresh_watch() for s in SIDES}}

    # ---------- persistence ----------
    def _kv(self, key, default):
        row = self.db.execute("select value from kv where key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def _put_kv(self, key, value):
        self.db.execute(
            "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value",
            (key, json.dumps(value)),
        )

    def _commit(self):
        self._put_kv("live", self.live)
        self._put_kv("settings", self.settings)
        self.version += 1
        self.changed.notify_all()

    # ---------- clock ----------
    @property
    def duration(self):
        return self.settings["matchDurationMs"]

    def _clock_elapsed(self, t):
        c = self.live["clock"]
        return c["accum"] + (t - c["since"] if c["since"] is not None else 0)

    def check_expiry(self, t=None):
        """Stop everything at the exact moment the match clock hits zero."""
        c = self.live["clock"]
        if c["since"] is None or c["over"]:
            return False
        t = now_ms() if t is None else t
        if self._clock_elapsed(t) < self.duration:
            return False
        end = c["since"] + (self.duration - c["accum"])
        for side in SIDES:
            w = self.live["sides"][side]
            if w["status"] == "running":
                w["accum"] += max(0, end - w["since"])
                w["since"] = None
            if w["status"] in ("running", "paused"):
                self._save_attempt(side, "timeout", end)
            w["status"] = "done"
        c.update(accum=self.duration, since=None, over=True)
        return True

    def tick(self):
        with self.lock:
            if self.check_expiry():
                self._commit()

    # ---------- attempts ----------
    def _team_id(self, side):
        m = self._match_row()
        return m["team_a"] if side == "A" else m["team_b"]

    def _match_row(self):
        if self.live["matchId"] is None:
            return None
        return self.db.execute("select * from matches where id = ?", (self.live["matchId"],)).fetchone()

    def _save_attempt(self, side, reason, t):
        w = self.live["sides"][side]
        if not w["laps"] and w["accum"] == 0:
            return False
        laps = list(w["laps"])
        score = sum(laps)
        self.db.execute(
            "insert into attempts(match_id, team_id, attempt_no, laps, partial_ms, checkpoints, score_ms, elapsed_ms, end_reason, created_at)"
            " values(?,?,?,?,?,?,?,?,?,?)",
            (self.live["matchId"], self._team_id(side), w["attemptNo"], json.dumps(laps), w["accum"],
             len(laps), score, score + w["accum"], reason, t),
        )
        return True

    def _attempts(self, match_id, team_id):
        rows = self.db.execute(
            "select * from attempts where match_id = ? and team_id = ? and voided = 0 order by attempt_no",
            (match_id, team_id),
        ).fetchall()
        return [
            {"no": r["attempt_no"], "laps": json.loads(r["laps"]), "partialMs": r["partial_ms"],
             "checkpoints": r["checkpoints"], "scoreMs": r["score_ms"], "elapsedMs": r["elapsed_ms"],
             "reason": r["end_reason"]}
            for r in rows
        ]

    def _best(self, match_id, team_id):
        attempts = self._attempts(match_id, team_id)
        return min(attempts, key=attempt_rank) if attempts else None

    # ---------- actions ----------
    def apply(self, action):
        with self.lock:
            t_server = now_ms()
            self.check_expiry(t_server)
            try:
                kind = action.get("type")
                handler = getattr(self, "_do_" + str(kind).replace(".", "_"), None)
                if handler is None:
                    raise ActionError(f"Unknown action: {kind}")
                handler(action, t_server)
            finally:
                # Commit even on a rejected action: the expiry check above may have changed state.
                self._commit()

    def _do_ping(self, a, t):
        pass

    def _action_time(self, a, t, w):
        """Use the operator's press time (already in server time) when it is plausible."""
        at = a.get("at")
        if not isinstance(at, (int, float)):
            return t
        floor = max(w["lastT"], w["since"] or 0, t - MAX_ACTION_SKEW_MS)
        return int(min(t, max(floor, at)))

    def _watch(self, a):
        if self.live["matchId"] is None:
            raise ActionError("No match is running. Set one up with Next Match.")
        side = a.get("side")
        if side not in SIDES:
            raise ActionError("side must be A or B")
        return side, self.live["sides"][side]

    def _do_watch_start(self, a, t):
        side, w = self._watch(a)
        c = self.live["clock"]
        if c["over"]:
            raise ActionError("Time is up for this match.")
        if w["status"] not in ("idle", "paused"):
            return
        t = self._action_time(a, t, w)
        w.update(status="running", since=t, lastT=t)
        if c["since"] is None:
            c["since"] = t

    def _do_watch_lap(self, a, t):
        side, w = self._watch(a)
        if w["status"] != "running":
            return
        t = self._action_time(a, t, w)
        w["laps"].append(w["accum"] + t - w["since"])
        w.update(accum=0, since=t, lastT=t)

    def _do_watch_stop(self, a, t):
        side, w = self._watch(a)
        if w["status"] != "running":
            return
        t = self._action_time(a, t, w)
        w.update(status="paused", accum=w["accum"] + t - w["since"], since=None, lastT=t)

    def _do_watch_reset(self, a, t):
        side, w = self._watch(a)
        if w["status"] != "paused":
            return
        saved = self._save_attempt(side, "reset", t)
        self.live["sides"][side] = fresh_watch(w["attemptNo"] + 1 if saved else w["attemptNo"])

    def _do_watch_undo(self, a, t):
        """Undo an accidental checkpoint press: fold the last split back into the current lap."""
        side, w = self._watch(a)
        if w["status"] not in ("running", "paused") or not w["laps"]:
            return
        w["accum"] += w["laps"].pop()

    def _do_clock_start(self, a, t):
        c = self.live["clock"]
        if self.live["matchId"] is None:
            raise ActionError("No match is running.")
        if not c["over"] and c["since"] is None:
            c["since"] = t

    def _do_clock_pause(self, a, t):
        """Emergency freeze: stops the match clock and both robots' timers."""
        c = self.live["clock"]
        if c["since"] is None:
            return
        c.update(accum=c["accum"] + t - c["since"], since=None)
        for w in self.live["sides"].values():
            if w["status"] == "running":
                w.update(status="paused", accum=w["accum"] + t - w["since"], since=None, lastT=t)

    def _do_match_restart(self, a, t):
        if self.live["matchId"] is None:
            raise ActionError("No match is running.")
        self.db.execute("update attempts set voided = 1 where match_id = ?", (self.live["matchId"],))
        self.live.update(clock=fresh_clock(), sides={s: fresh_watch() for s in SIDES})

    def _do_match_next(self, a, t):
        """Close the current match (optionally with a winner) and/or open the next one."""
        m = self._match_row()
        if m is not None:
            for side in SIDES:
                w = self.live["sides"][side]
                if w["status"] == "running":
                    w.update(accum=w["accum"] + t - w["since"], since=None)
                if w["status"] in ("running", "paused"):
                    self._save_attempt(side, "match_end", t)
            winner = a.get("winner")
            winner_id = {"A": m["team_a"], "B": m["team_b"]}.get(winner)
            self.db.execute("update matches set status = 'done', winner = ?, ended_at = ? where id = ?",
                            (winner_id, t, m["id"]))
            if winner_id is not None:
                loser_id = m["team_b"] if winner == "A" else m["team_a"]
                self.db.execute("update teams set eliminated = 1, eliminated_round = ? where id = ?",
                                (m["round"], loser_id))
                self.db.execute("update teams set eliminated = 0, eliminated_round = null where id = ?",
                                (winner_id,))
        nxt = a.get("next")
        match_id = None
        if nxt:
            round_, ta, tb = self._validate_pairing(nxt)
            cur = self.db.execute("insert into matches(round, team_a, team_b, started_at) values(?,?,?,?)",
                                  (round_, ta, tb, t))
            match_id = cur.lastrowid
        self.live = {"matchId": match_id, "clock": fresh_clock(), "sides": {s: fresh_watch() for s in SIDES}}

    def _do_match_edit(self, a, t):
        """Fix a pairing typo before anything has been timed."""
        m = self._match_row()
        if m is None:
            raise ActionError("No match is running.")
        c = self.live["clock"]
        if c["since"] is not None or c["accum"] or any(w["status"] != "idle" for w in self.live["sides"].values()) \
                or self.db.execute("select 1 from attempts where match_id = ? and voided = 0", (m["id"],)).fetchone():
            raise ActionError("This match already has times. Use Restart Match first.")
        round_, ta, tb = self._validate_pairing(a)
        self.db.execute("update matches set round = ?, team_a = ?, team_b = ? where id = ?", (round_, ta, tb, m["id"]))

    def _validate_pairing(self, p):
        try:
            round_, ta, tb = int(p.get("round")), int(p.get("teamA")), int(p.get("teamB"))
        except (TypeError, ValueError):
            raise ActionError("Pick a round and two teams.")
        if round_ not in ROUNDS:
            raise ActionError("Round must be 16, 8, 4 or 2.")
        if ta == tb:
            raise ActionError("A team can't race itself.")
        for tid in (ta, tb):
            if not self.db.execute("select 1 from teams where id = ?", (tid,)).fetchone():
                raise ActionError("Unknown team.")
        return round_, ta, tb

    # ---------- teams ----------
    def _clean_name(self, name):
        name = str(name or "").strip()
        if not name:
            raise ActionError("Team name can't be empty.")
        if len(name) > 60:
            raise ActionError("Team name is too long.")
        return name

    def _do_teams_add(self, a, t):
        name = self._clean_name(a.get("name"))
        try:
            self.db.execute("insert into teams(name, headstart, created_at) values(?,?,?)",
                            (name, str(a.get("headstart") or "").strip()[:20], t))
        except sqlite3.IntegrityError:
            raise ActionError(f"A team called {name} already exists.")

    def _do_teams_bulk(self, a, t):
        """One team per line: `name, headstart` (comma or tab). Existing names get their headstart updated."""
        for line in str(a.get("text") or "").splitlines():
            if not line.strip():
                continue
            parts = [p.strip() for p in (line.split("\t") if "\t" in line else line.rsplit(",", 1))]
            name = self._clean_name(parts[0])
            head = parts[1][:20] if len(parts) > 1 else ""
            self.db.execute(
                "insert into teams(name, headstart, created_at) values(?,?,?)"
                " on conflict(name) do update set headstart = excluded.headstart",
                (name, head, t),
            )

    def _do_teams_update(self, a, t):
        tid = a.get("id")
        row = self.db.execute("select * from teams where id = ?", (tid,)).fetchone()
        if row is None:
            raise ActionError("Unknown team.")
        name = self._clean_name(a["name"]) if "name" in a else row["name"]
        head = str(a["headstart"]).strip()[:20] if "headstart" in a else row["headstart"]
        elim = int(bool(a["eliminated"])) if "eliminated" in a else row["eliminated"]
        elim_round = row["eliminated_round"] if elim else None
        try:
            self.db.execute("update teams set name = ?, headstart = ?, eliminated = ?, eliminated_round = ? where id = ?",
                            (name, head, elim, elim_round, tid))
        except sqlite3.IntegrityError:
            raise ActionError(f"A team called {name} already exists.")

    def _do_teams_delete(self, a, t):
        tid = a.get("id")
        if self.db.execute("select 1 from matches where team_a = ? or team_b = ?", (tid, tid)).fetchone():
            raise ActionError("This team has raced already. Mark it eliminated instead.")
        self.db.execute("delete from teams where id = ?", (tid,))

    def _do_settings_update(self, a, t):
        if "matchDurationMs" in a:
            c = self.live["clock"]
            if c["since"] is not None or c["accum"]:
                raise ActionError("Change the match length between matches (or after Restart Match).")
            ms = int(a["matchDurationMs"])
            if not 10_000 <= ms <= 60 * 60 * 1000:
                raise ActionError("Match length must be between 10 s and 60 min.")
            self.settings["matchDurationMs"] = ms
        if "trackCheckpoints" in a:
            n = int(a["trackCheckpoints"])
            if not 2 <= n <= 12:
                raise ActionError("Track checkpoints must be between 2 and 12.")
            self.settings["trackCheckpoints"] = n

    # ---------- reads ----------
    def snapshot(self):
        with self.lock:
            teams = [
                {"id": r["id"], "name": r["name"], "headstart": r["headstart"],
                 "eliminated": bool(r["eliminated"]), "eliminatedRound": r["eliminated_round"]}
                for r in self.db.execute("select * from teams order by eliminated, id")
            ]
            names = {tm["id"]: tm["name"] for tm in teams}
            match = None
            m = self._match_row()
            if m is not None:
                sides = {}
                for side, tid in (("A", m["team_a"]), ("B", m["team_b"])):
                    w = self.live["sides"][side]
                    attempts = self._attempts(m["id"], tid)
                    sides[side] = {
                        "teamId": tid,
                        "watch": {k: w[k] for k in ("status", "laps", "accum", "since", "attemptNo")},
                        "attempts": attempts,
                        "best": min(attempts, key=attempt_rank) if attempts else None,
                    }
                match = {"id": m["id"], "round": m["round"], "sides": sides}
            results = [
                {"id": r["id"], "round": r["round"], "teamA": names.get(r["team_a"]), "teamB": names.get(r["team_b"]),
                 "winner": names.get(r["winner"]), "endedAt": r["ended_at"]}
                for r in self.db.execute("select * from matches where status = 'done' order by id desc limit 40")
            ]
            return {
                "version": self.version,
                "serverNow": now_ms(),
                "settings": self.settings,
                "teams": teams,
                "match": match,
                "clock": {**self.live["clock"], "durationMs": self.duration},
                "results": results,
            }

    def export_csv(self):
        with self.lock:
            rows = self.db.execute(
                "select a.*, m.round, t.name as team from attempts a join matches m on m.id = a.match_id"
                " join teams t on t.id = a.team_id order by a.id"
            ).fetchall()
        out = io.StringIO()
        wr = csv.writer(out)
        wr.writerow(["attempt_id", "match_id", "round", "team", "attempt_no", "checkpoints", "score_ms",
                     "elapsed_ms", "partial_ms", "laps_ms", "end_reason", "voided", "created_at"])
        for r in rows:
            wr.writerow([r["id"], r["match_id"], r["round"], r["team"], r["attempt_no"], r["checkpoints"],
                         r["score_ms"], r["elapsed_ms"], r["partial_ms"], " ".join(map(str, json.loads(r["laps"]))),
                         r["end_reason"], r["voided"],
                         time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["created_at"] / 1000))])
        return out.getvalue()


STORE = Store(DB_PATH)

PAGES = {"/": "display.html", "/display": "display.html", "/admin": "admin.html"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ZipItFinals/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("ZIPIT_QUIET"):
            return
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj))

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        if path in PAGES:
            return self._static(PAGES[path])
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if path == "/api/state":
            return self._json(200, STORE.snapshot())
        if path == "/api/events":
            return self._events()
        if path == "/api/export.csv":
            if parse_qs(url.query).get("key", [""])[0] != ADMIN_KEY:
                return self._json(403, {"error": "Wrong admin key."})
            return self._send(200, STORE.export_csv(), "text/csv; charset=utf-8",
                              {"Content-Disposition": 'attachment; filename="zipit-finals-attempts.csv"'})
        self._json(404, {"error": "Not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/api/action":
            return self._json(404, {"error": "Not found"})
        if self.headers.get("X-Admin-Key") != ADMIN_KEY:
            return self._json(403, {"error": "Wrong admin key."})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            action = json.loads(self.rfile.read(length) or b"{}")
            STORE.apply(action)
        except ActionError as e:
            return self._json(400, {"error": str(e), "state": STORE.snapshot()})
        except (ValueError, KeyError, TypeError) as e:
            return self._json(400, {"error": f"Bad request: {e}"})
        self._json(200, {"ok": True, "state": STORE.snapshot()})

    def _static(self, rel):
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            return self._json(404, {"error": "Not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last = None
        try:
            while True:
                with STORE.changed:
                    if STORE.version == last:
                        STORE.changed.wait(timeout=15)
                    version = STORE.version
                if version != last:
                    self.wfile.write(b"data: " + json.dumps(STORE.snapshot()).encode() + b"\n\n")
                    last = version
                else:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def ticker():
    while True:
        time.sleep(0.05)
        try:
            STORE.tick()
        except Exception as e:  # keep the clock thread alive no matter what
            sys.stderr.write(f"tick error: {e}\n")


def main():
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    threading.Thread(target=ticker, daemon=True).start()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    shown = "localhost" if HOST in ("0.0.0.0", "") else HOST
    print(f"ZipIt finals running:\n  display  http://{shown}:{PORT}/\n  admin    http://{shown}:{PORT}/admin")
    if ADMIN_KEY == "zipit-admin":
        print("  admin key: zipit-admin  (set ZIPIT_ADMIN_KEY to change it)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
