#!/usr/bin/env python3
"""ZipIt finals scoreboard server.

Standard library only: run `python3 server.py` and open
  http://<host>:8000/        audience display
  http://<host>:8000/admin   operator console (needs ZIPIT_ADMIN_KEY)

The server is the single source of truth. Every timer is stored as
"accumulated ms + running-since timestamp", so a browser refresh or a server
restart never loses time. Clients get pushed snapshots over Server-Sent Events
and animate the clocks locally from those timestamps.

Tournament: single elimination. The team list order is the seeding; the first
round pairs seeds by standard recursive bracket order (1v16, 8v9, 4v13, ...),
with byes for the top seeds when the team count isn't a power of two.
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

SIDES = ("A", "B")
MAX_TEAMS = 64
DEFAULT_SETTINGS = {"matchDurationMs": 10 * 60 * 1000, "defaultCheckpoints": 6}
# How far a client-supplied action timestamp may lag the server clock (network jitter).
MAX_ACTION_SKEW_MS = 2000

SCHEMA = """
create table if not exists teams (
  id integer primary key,
  name text not null unique collate nocase,
  headstart real not null default 0,             -- seconds, subtracted from the run time
  seed integer not null,
  created_at integer not null
);
create table if not exists matches (
  id integer primary key,
  round integer not null,                        -- bracket size of the round: 16, 8, 4, 2
  slot integer not null,                         -- position in the round, top to bottom
  team_a integer references teams(id),           -- null = bye
  team_b integer references teams(id),
  status text not null default 'pending',        -- pending | live | done
  winner integer references teams(id),
  checkpoints integer not null,
  started_at integer,
  ended_at integer,
  unique(round, slot)
);
create table if not exists attempts (
  id integer primary key,
  match_id integer not null references matches(id),
  team_id integer not null references teams(id),
  attempt_no integer not null,
  laps text not null,                            -- JSON list of checkpoint split times (ms)
  partial_ms integer not null,                   -- unfinished lap when the attempt ended
  end_reason text not null,                      -- reset | timeout | match_end
  edited integer not null default 0,
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
    # status: idle | running | paused | complete (all checkpoints reached) | done (time up)
    return {"status": "idle", "laps": [], "accum": 0, "since": None, "attemptNo": attempt_no, "lastT": 0}


def fresh_clock():
    return {"accum": 0, "since": None, "over": False}


def fresh_live(match_id=None):
    return {"matchId": match_id, "clock": fresh_clock(), "sides": {s: fresh_watch() for s in SIDES}}


def fresh_tournament():
    return {"size": None, "round": None, "view": "setup", "champion": None}


def bracket_order(size):
    """Seed order for the first round: [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11] for 16."""
    order = [1]
    while len(order) < size:
        n = len(order) * 2
        order = [x for s in order for x in (s, n + 1 - s)]
    return order


def round_name(size):
    return {2: "The Final", 4: "Semi-finals", 8: "Quarter-finals"}.get(size, f"Round of {size}")


def attempt_rank(a, checkpoints):
    """More checkpoints first (capped at the course length), then lower score (time - headstart)."""
    return (-min(a["checkpoints"], checkpoints), a["scoreMs"])


def ms_list(value):
    if not isinstance(value, list) or not all(isinstance(x, (int, float)) and 0 <= x < 3_600_000 for x in value):
        raise ActionError("Times must be between 0 and 60 minutes.")
    return [int(x) for x in value]


class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode=wal")
        self.db.execute("pragma foreign_keys=on")
        self._migrate()
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.settings = {**DEFAULT_SETTINGS, **self._kv("settings", {})}
        self.settings.pop("trackCheckpoints", None)
        self.live = self._kv("live", None) or fresh_live()
        self.tour = self._kv("tournament", None) or fresh_tournament()

    def _migrate(self):
        """v1 databases had free-text headstarts and manual pairings: keep the teams, drop the rest."""
        cols = {r["name"] for r in self.db.execute("pragma table_info(teams)")}
        if not cols or "seed" in cols:
            return
        old = self.db.execute("select name, headstart from teams order by id").fetchall()
        self.db.executescript("drop table if exists attempts; drop table if exists matches; drop table if exists teams;")
        self.db.executescript(SCHEMA)
        self.db.execute("delete from kv where key in ('live', 'tournament')")
        for i, r in enumerate(old, 1):
            try:
                head = float(str(r["headstart"]).strip().rstrip("s") or 0)
            except ValueError:
                head = 0.0
            self.db.execute("insert into teams(name, headstart, seed, created_at) values(?,?,?,?)",
                            (r["name"], head, i, now_ms()))

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
        self._put_kv("tournament", self.tour)
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
            if w["status"] in ("running", "paused", "complete"):
                self._save_attempt(side, "timeout", end)
            w["status"] = "done"
        c.update(accum=self.duration, since=None, over=True)
        return True

    def tick(self):
        with self.lock:
            if self.check_expiry():
                self._commit()

    # ---------- matches ----------
    def _match_row(self, match_id=None):
        match_id = self.live["matchId"] if match_id is None else match_id
        if match_id is None:
            return None
        return self.db.execute("select * from matches where id = ?", (match_id,)).fetchone()

    def _round_rows(self, round_):
        return self.db.execute("select * from matches where round = ? order by slot", (round_,)).fetchall()

    def _team_id(self, side):
        m = self._match_row()
        return m["team_a"] if side == "A" else m["team_b"]

    def _headstarts(self):
        return {r["id"]: r["headstart"] for r in self.db.execute("select id, headstart from teams")}

    # ---------- attempts ----------
    def _save_attempt(self, side, reason, t):
        w = self.live["sides"][side]
        if not w["laps"] and w["accum"] == 0:
            return False
        self.db.execute(
            "insert into attempts(match_id, team_id, attempt_no, laps, partial_ms, end_reason, created_at)"
            " values(?,?,?,?,?,?,?)",
            (self.live["matchId"], self._team_id(side), w["attemptNo"], json.dumps(w["laps"]), w["accum"], reason, t),
        )
        return True

    def _attempts(self, match_id, team_id, headstart):
        rows = self.db.execute(
            "select * from attempts where match_id = ? and team_id = ? and voided = 0 order by attempt_no, id",
            (match_id, team_id),
        ).fetchall()
        out = []
        for r in rows:
            laps = json.loads(r["laps"])
            run = sum(laps)
            out.append({
                "id": r["id"], "no": r["attempt_no"], "laps": laps, "partialMs": r["partial_ms"],
                "checkpoints": len(laps), "timeMs": run, "totalMs": run + r["partial_ms"],
                "scoreMs": run - int(round(headstart * 1000)), "reason": r["end_reason"], "edited": bool(r["edited"]),
            })
        return out

    def _side_summary(self, m, side, heads):
        tid = m["team_a"] if side == "A" else m["team_b"]
        if tid is None:
            return {"teamId": None, "attempts": [], "best": None}
        attempts = self._attempts(m["id"], tid, heads.get(tid, 0))
        best = min(attempts, key=lambda a: attempt_rank(a, m["checkpoints"])) if attempts else None
        return {"teamId": tid, "attempts": attempts, "best": best}

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
            raise ActionError("No match is running.")
        side = a.get("side")
        if side not in SIDES:
            raise ActionError("side must be A or B")
        return self.live["sides"][side]

    def _do_watch_start(self, a, t):
        w = self._watch(a)
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
        w = self._watch(a)
        if w["status"] != "running":
            return
        t = self._action_time(a, t, w)
        w["laps"].append(w["accum"] + t - w["since"])
        w.update(accum=0, since=t, lastT=t)
        if len(w["laps"]) >= self._match_row()["checkpoints"]:
            # Last checkpoint is the finish line: the run is over.
            w.update(status="complete", since=None)

    def _do_watch_stop(self, a, t):
        w = self._watch(a)
        if w["status"] != "running":
            return
        t = self._action_time(a, t, w)
        w.update(status="paused", accum=w["accum"] + t - w["since"], since=None, lastT=t)

    def _do_watch_reset(self, a, t):
        side = a.get("side")
        w = self._watch(a)
        if w["status"] not in ("paused", "complete"):
            return
        saved = self._save_attempt(side, "reset", t)
        self.live["sides"][side] = fresh_watch(w["attemptNo"] + 1 if saved else w["attemptNo"])

    def _do_watch_undo(self, a, t):
        """Undo an accidental checkpoint press: fold the last split back into the current lap."""
        w = self._watch(a)
        if w["status"] not in ("running", "paused", "complete") or not w["laps"]:
            return
        w["accum"] += w["laps"].pop()
        if w["status"] == "complete":
            w["status"] = "paused"

    def _do_watch_edit(self, a, t):
        """Correct the splits of the attempt in progress (same number of checkpoints)."""
        w = self._watch(a)
        laps = ms_list(a.get("laps"))
        if len(laps) != len(w["laps"]):
            raise ActionError("Use Undo to remove a checkpoint; editing keeps the same number of splits.")
        w["laps"] = laps

    def _do_attempt_edit(self, a, t):
        row = self.db.execute("select * from attempts where id = ?", (a.get("id"),)).fetchone()
        if row is None:
            raise ActionError("Unknown attempt.")
        laps = ms_list(a.get("laps"))
        total = int(a.get("totalMs", sum(laps) + row["partial_ms"]))
        if total < sum(laps):
            raise ActionError("Total time can't be less than the checkpoint splits added up.")
        self.db.execute("update attempts set laps = ?, partial_ms = ?, edited = 1 where id = ?",
                        (json.dumps(laps), total - sum(laps), row["id"]))

    def _do_attempt_delete(self, a, t):
        self.db.execute("update attempts set voided = 1 where id = ?", (a.get("id"),))

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

    # ---------- match / tournament flow ----------
    def _do_match_restart(self, a, t):
        if self.live["matchId"] is None:
            raise ActionError("No match is running.")
        self.db.execute("update attempts set voided = 1 where match_id = ?", (self.live["matchId"],))
        self.live = fresh_live(self.live["matchId"])

    def _do_match_checkpoints(self, a, t):
        m = self._match_row()
        if m is None:
            raise ActionError("No match is running.")
        n = int(a.get("n", 0))
        if not 1 <= n <= 30:
            raise ActionError("Checkpoints must be between 1 and 30.")
        most = max(len(w["laps"]) for w in self.live["sides"].values())
        if n < most:
            raise ActionError(f"A team has already passed {most} checkpoints.")
        self.db.execute("update matches set checkpoints = ? where id = ?", (n, m["id"]))
        for w in self.live["sides"].values():
            if w["status"] == "complete" and len(w["laps"]) < n:
                w["status"] = "paused"   # course got longer: the run can carry on

    def _do_match_finish(self, a, t):
        m = self._match_row()
        if m is None:
            raise ActionError("No match is running.")
        winner = a.get("winner")
        if winner not in SIDES:
            raise ActionError("Pick the winner.")
        for side in SIDES:
            w = self.live["sides"][side]
            if w["status"] == "running":
                w.update(accum=w["accum"] + t - w["since"], since=None)
            if w["status"] in ("running", "paused", "complete"):
                self._save_attempt(side, "match_end", t)
        winner_id = m["team_a"] if winner == "A" else m["team_b"]
        self.db.execute("update matches set status = 'done', winner = ?, ended_at = ? where id = ?",
                        (winner_id, t, m["id"]))
        self._start_next(t, m["checkpoints"])

    def _start_next(self, t, checkpoints=None):
        """Start the next unplayed match of the current round, or show the bracket when the round is over."""
        nxt = self.db.execute("select * from matches where round = ? and status = 'pending' order by slot limit 1",
                              (self.tour["round"],)).fetchone()
        if nxt is None:
            self.live = fresh_live()
            self.tour["view"] = "bracket"
            if self.tour["round"] == 2:
                final = self._round_rows(2)[0]
                self.tour["champion"] = final["winner"]
            return
        if checkpoints is not None:
            self.db.execute("update matches set checkpoints = ? where id = ?", (checkpoints, nxt["id"]))
        self.db.execute("update matches set status = 'live', started_at = ? where id = ?", (t, nxt["id"]))
        self.live = fresh_live(nxt["id"])
        self.tour["view"] = "match"

    def _do_bracket_generate(self, a, t):
        if self.db.execute("select 1 from matches").fetchone():
            raise ActionError("A bracket already exists. Reset the tournament first.")
        teams = self.db.execute("select id from teams order by seed, id").fetchall()
        n = len(teams)
        if n < 2:
            raise ActionError("Add at least two teams.")
        size = 2
        while size < n:
            size *= 2
        by_seed = {i + 1: r["id"] for i, r in enumerate(teams)}
        order = bracket_order(size)
        cps = self.settings["defaultCheckpoints"]
        for slot in range(size // 2):
            ta, tb = by_seed.get(order[2 * slot]), by_seed.get(order[2 * slot + 1])
            bye = ta is None or tb is None
            self.db.execute(
                "insert into matches(round, slot, team_a, team_b, status, winner, checkpoints, ended_at) values(?,?,?,?,?,?,?,?)",
                (size, slot, ta, tb, "done" if bye else "pending", (ta or tb) if bye else None, cps, t if bye else None),
            )
        self.tour = {"size": size, "round": size, "view": "bracket", "champion": None}
        self.live = fresh_live()

    def _do_tournament_reset(self, a, t):
        self.db.execute("delete from attempts")
        self.db.execute("delete from matches")
        self.tour = fresh_tournament()
        self.live = fresh_live()

    def _do_round_proceed(self, a, t):
        """Start the current round, or build the next round from this round's winners."""
        if self.tour["size"] is None:
            raise ActionError("Generate the bracket first.")
        if self.live["matchId"] is not None:
            self.tour["view"] = "match"
            return
        r = self.tour["round"]
        rows = self._round_rows(r)
        if any(m["status"] == "pending" for m in rows):
            return self._start_next(t)
        if r == 2:
            raise ActionError("The tournament is over.")
        cps = max(rows, key=lambda m: m["ended_at"] or 0)["checkpoints"]
        nxt = r // 2
        for slot in range(nxt // 2):
            ta, tb = rows[2 * slot]["winner"], rows[2 * slot + 1]["winner"]
            self.db.execute("insert into matches(round, slot, team_a, team_b, checkpoints) values(?,?,?,?,?)",
                            (nxt, slot, ta, tb, cps))
        self.tour["round"] = nxt
        self._start_next(t)

    def _do_view_set(self, a, t):
        view = a.get("view")
        if view == "match" and self.live["matchId"] is None:
            raise ActionError("No match is running.")
        if view not in ("match", "bracket") or self.tour["size"] is None:
            raise ActionError("Nothing to show yet.")
        self.tour["view"] = view

    # ---------- teams ----------
    def _clean_name(self, name):
        name = str(name or "").strip()
        if not name:
            raise ActionError("Team name can't be empty.")
        if len(name) > 60:
            raise ActionError("Team name is too long.")
        return name

    def _headstart(self, value):
        s = str(value if value is not None else "").strip().rstrip("sS").strip()
        if not s:
            return 0.0
        try:
            v = float(s)
        except ValueError:
            raise ActionError("Headstart must be a number of seconds.")
        if not 0 <= v <= 3600:
            raise ActionError("Headstart must be between 0 and 3600 seconds.")
        return v

    def _next_seed(self):
        return (self.db.execute("select max(seed) from teams").fetchone()[0] or 0) + 1

    def _do_teams_add(self, a, t):
        name = self._clean_name(a.get("name"))
        if self.db.execute("select count(*) from teams").fetchone()[0] >= MAX_TEAMS:
            raise ActionError("Too many teams.")
        try:
            self.db.execute("insert into teams(name, headstart, seed, created_at) values(?,?,?,?)",
                            (name, self._headstart(a.get("headstart")), self._next_seed(), t))
        except sqlite3.IntegrityError:
            raise ActionError(f"A team called {name} already exists.")

    def _do_teams_bulk(self, a, t):
        """One team per line, in seed order: `name, headstart` (comma or tab). Existing names get their headstart updated."""
        rows = []
        for i, line in enumerate(str(a.get("text") or "").splitlines(), 1):
            if not line.strip():
                continue
            parts = [p.strip() for p in (line.split("\t") if "\t" in line else line.rsplit(",", 1))]
            try:
                rows.append((self._clean_name(parts[0]), self._headstart(parts[1] if len(parts) > 1 else "")))
            except ActionError as e:
                raise ActionError(f"Line {i}: {e}")
        for name, head in rows:
            if self.db.execute("select 1 from teams where name = ?", (name,)).fetchone():
                self.db.execute("update teams set headstart = ? where name = ?", (head, name))
            else:
                self.db.execute("insert into teams(name, headstart, seed, created_at) values(?,?,?,?)",
                                (name, head, self._next_seed(), t))

    def _do_teams_update(self, a, t):
        row = self.db.execute("select * from teams where id = ?", (a.get("id"),)).fetchone()
        if row is None:
            raise ActionError("Unknown team.")
        name = self._clean_name(a["name"]) if "name" in a else row["name"]
        head = self._headstart(a["headstart"]) if "headstart" in a else row["headstart"]
        try:
            self.db.execute("update teams set name = ?, headstart = ? where id = ?", (name, head, row["id"]))
        except sqlite3.IntegrityError:
            raise ActionError(f"A team called {name} already exists.")

    def _do_teams_move(self, a, t):
        """Swap a team's seed with its neighbour above (dir -1) or below (dir 1)."""
        if self.tour["size"] is not None:
            raise ActionError("Seeds are locked once the bracket exists. Reset the tournament to reseed.")
        teams = [r["id"] for r in self.db.execute("select id from teams order by seed, id")]
        if a.get("id") not in teams:
            raise ActionError("Unknown team.")
        i = teams.index(a["id"])
        j = i + (1 if a.get("dir") == 1 else -1)
        if not 0 <= j < len(teams):
            return
        teams[i], teams[j] = teams[j], teams[i]
        for seed, tid in enumerate(teams, 1):
            self.db.execute("update teams set seed = ? where id = ?", (seed, tid))

    def _do_teams_delete(self, a, t):
        tid = a.get("id")
        if self.db.execute("select 1 from matches where team_a = ? or team_b = ?", (tid, tid)).fetchone():
            raise ActionError("This team is in the bracket. Reset the tournament to remove it.")
        self.db.execute("delete from teams where id = ?", (tid,))
        for seed, r in enumerate(self.db.execute("select id from teams order by seed, id").fetchall(), 1):
            self.db.execute("update teams set seed = ? where id = ?", (seed, r["id"]))

    def _do_settings_update(self, a, t):
        if "matchDurationMs" in a:
            c = self.live["clock"]
            if c["since"] is not None or c["accum"]:
                raise ActionError("Change the match length between matches (or after Restart Match).")
            ms = int(a["matchDurationMs"])
            if not 10_000 <= ms <= 60 * 60 * 1000:
                raise ActionError("Match length must be between 10 s and 60 min.")
            self.settings["matchDurationMs"] = ms
        if "defaultCheckpoints" in a:
            n = int(a["defaultCheckpoints"])
            if not 1 <= n <= 30:
                raise ActionError("Checkpoints must be between 1 and 30.")
            self.settings["defaultCheckpoints"] = n

    # ---------- reads ----------
    def _bracket(self, names, heads):
        size = self.tour["size"]
        if size is None:
            return []
        live_id = self.live["matchId"]
        rounds, prev = [], None
        r = size
        while r >= 2:
            rows = self._round_rows(r)
            matches = []
            count = r // 2
            for slot in range(count):
                row = rows[slot] if slot < len(rows) else None
                if row is not None:
                    ta, tb, status, winner = row["team_a"], row["team_b"], row["status"], row["winner"]
                    summary = {s: self._side_summary(row, s, heads)["best"] for s in SIDES} if status == "done" else {}
                else:
                    # not created yet: fill in whoever has already won their way here
                    def won(i):
                        return prev[i]["winnerId"] if prev and i < len(prev) else None
                    ta, tb, status, winner, summary = won(2 * slot), won(2 * slot + 1), "future", None, {}
                bye = status == "done" and (ta is None or tb is None)
                matches.append({
                    "id": row["id"] if row is not None else None, "slot": slot, "status": status,
                    "checkpoints": row["checkpoints"] if row is not None else None,
                    "live": row is not None and row["id"] == live_id, "bye": bye, "winnerId": winner,
                    "a": self._bteam(ta, names), "b": self._bteam(tb, names),
                    "bestA": summary.get("A"), "bestB": summary.get("B"),
                })
            rounds.append({"round": r, "name": round_name(r), "matches": matches})
            prev = matches
            r //= 2
        return rounds

    @staticmethod
    def _bteam(tid, names):
        if tid is None:
            return None
        name, seed = names[tid]
        return {"id": tid, "name": name, "seed": seed}

    def snapshot(self):
        with self.lock:
            rows = self.db.execute("select * from teams order by seed, id").fetchall()
            names = {r["id"]: (r["name"], r["seed"]) for r in rows}
            heads = {r["id"]: r["headstart"] for r in rows}
            lost = {}
            for m in self.db.execute("select * from matches where status = 'done' and winner is not null"):
                for tid in (m["team_a"], m["team_b"]):
                    if tid is not None and tid != m["winner"]:
                        lost[tid] = m["round"]
            in_bracket = {r[0] for r in self.db.execute("select team_a from matches union select team_b from matches")}
            teams = [
                {"id": r["id"], "name": r["name"], "headstart": r["headstart"], "seed": r["seed"],
                 "eliminated": r["id"] in lost, "eliminatedRound": lost.get(r["id"]),
                 "unseeded": self.tour["size"] is not None and r["id"] not in in_bracket}
                for r in rows
            ]
            match = None
            m = self._match_row()
            if m is not None:
                round_rows = self._round_rows(m["round"])
                playable = [x for x in round_rows if x["team_a"] is not None and x["team_b"] is not None]
                sides = {}
                for side in SIDES:
                    w = self.live["sides"][side]
                    sides[side] = {**self._side_summary(m, side, heads),
                                   "watch": {k: w[k] for k in ("status", "laps", "accum", "since", "attemptNo")}}
                match = {"id": m["id"], "round": m["round"], "slot": m["slot"], "checkpoints": m["checkpoints"],
                         "matchNo": [x["id"] for x in playable].index(m["id"]) + 1, "matchCount": len(playable),
                         "sides": sides}
            tour = dict(self.tour)
            if tour["size"] is not None:
                rr = self._round_rows(tour["round"])
                tour["roundOver"] = all(x["status"] == "done" for x in rr)
                tour["roundStarted"] = any(x["status"] != "pending" and x["team_a"] and x["team_b"] for x in rr)
            return {
                "version": self.version,
                "serverNow": now_ms(),
                "settings": self.settings,
                "teams": teams,
                "tournament": tour,
                "bracket": self._bracket(names, heads),
                "match": match,
                "clock": {**self.live["clock"], "durationMs": self.duration},
            }

    def export_csv(self):
        with self.lock:
            rows = self.db.execute(
                "select a.*, m.round, m.slot, t.name as team, t.headstart from attempts a"
                " join matches m on m.id = a.match_id join teams t on t.id = a.team_id order by a.id"
            ).fetchall()
        out = io.StringIO()
        wr = csv.writer(out)
        wr.writerow(["attempt_id", "round", "match_slot", "team", "headstart_s", "attempt_no", "checkpoints",
                     "time_ms", "score_ms", "total_ms", "laps_ms", "end_reason", "edited", "voided", "created_at"])
        for r in rows:
            laps = json.loads(r["laps"])
            wr.writerow([r["id"], r["round"], r["slot"] + 1, r["team"], r["headstart"], r["attempt_no"], len(laps),
                         sum(laps), sum(laps) - int(round(r["headstart"] * 1000)), sum(laps) + r["partial_ms"],
                         " ".join(map(str, laps)), r["end_reason"], r["edited"], r["voided"],
                         time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["created_at"] / 1000))])
        return out.getvalue()


STORE = Store(DB_PATH)

PAGES = {"/": "display.html", "/display": "display.html", "/admin": "admin.html"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ZipItFinals/2.0"

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
