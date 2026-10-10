# ZipIt Finals

Live scoreboard for the ZipIt line-follower finals. It has two views of the same match:

| URL | Who sees it | What it does |
| --- | --- | --- |
| `/` | Audience (projector) | Round, 10-minute countdown, both teams' current attempt and splits, a Mario Kart-style track per team, overall stats, team list |
| `/admin` | Operator | Same board, plus iPhone-style lap timers, team editing, match flow |

## Run it

Needs Python 3.8 or newer and nothing else (no pip installs, no Node).

```bash
ZIPIT_ADMIN_KEY='pick-a-secret' python3 server.py
```

- Audience display: `http://<laptop-ip>:8000/`
- Admin console: `http://<laptop-ip>:8000/admin` (asks for the admin key once per browser)

Any device on the same Wi-Fi can open either page. Everything stays in sync live.

| Env var | Default | Meaning |
| --- | --- | --- |
| `ZIPIT_ADMIN_KEY` | `zipit-admin` | Key the admin console must send. **Change it on event day.** |
| `PORT` / `HOST` | `8000` / `0.0.0.0` | Where to listen |
| `ZIPIT_DB` | `data/zipit.db` | SQLite file with teams, matches and every attempt |

## The timer (admin)

Each team has its own iPhone-style lap timer:

| State | Left button | Right button |
| --- | --- | --- |
| Ready | Checkpoint (disabled) | **Start** |
| Running | **Checkpoint**: ends the current lap (split saved), next one starts | **Stop**: pauses the current lap |
| Paused | **Reset**: saves this attempt and starts a fresh one | **Start**: resumes the same lap |

- The 10-minute match clock starts with the first Start of either team. At 0:00 both timers stop on their own, any unfinished attempt is saved, and the controls lock.
- Keyboard: team A `Q` (checkpoint/reset) and `W` (start/stop), team B `O` and `P`. Buttons fire on press, not release, so splits are stamped the moment you tap.
- **Undo last checkpoint** folds an accidental split back into the current lap.
- **Pause everything** freezes the match clock and both robots (emergencies). Start either robot or press Resume clock to continue.
- **Restart match** discards every attempt in the current match (kept in the CSV as voided) and resets the clock.
- **Next match** asks for the winner (it suggests the team with the better best attempt), knocks out the loser (greyed out on the team list), and sets the next pairing. Tick "No next match" after the final to show the champion screen.
- **Edit pairing** fixes a wrong pairing before anything has been timed.

### Scoring

An attempt's score is **checkpoints reached, then time to the last checkpoint** (more checkpoints wins; ties go to the faster time). The unfinished lap is stored but not scored. This lives in `attempt_rank()` in `server.py` and `better()` in `static/js/admin.js` if the rules change.

Headstart is a free-text value per team (e.g. `12` or `+5s`). It's shown on the team list and in the pairing dropdowns, and isn't used in scoring.

## Data

- Teams: add one at a time, or paste many under **Bulk import** (`Team name, headstart` per line).
- **Results → Download all attempts (CSV)** exports every attempt with its splits.
- Settings: match length (default 10 min) and how many checkpoints the audience track draws (default 6; it's cosmetic).
- All state, including running timers, survives a browser refresh or a server restart. To wipe everything, stop the server and delete `data/`.

## Layout

```
server.py            HTTP + Server-Sent Events + SQLite (standard library only)
static/display.html  audience page
static/admin.html    operator page
static/css/zipit.css "Comic Circuit" theme from the ZipIT site
static/js/core.js    live connection, clock sync, formatting
static/js/view.js    shared board rendering
static/js/track.js   kart track animation
static/js/display.js audience logic
static/js/admin.js   operator logic
```

Fonts come from Google Fonts. Without internet the pages fall back to system fonts and still work.
