# ZipIt Finals

Live scoreboard for the ZipIt line-follower finals. It has two views of the same match:

| URL | Who sees it | What it does |
| --- | --- | --- |
| `/` | Audience (projector) | Round and match, 10-minute countdown, both teams' current attempt and splits, a Mario Kart-style track per team, best scores, team list, the bracket between rounds |
| `/admin` | Operator | Same board on one screen, plus iPhone-style lap timers, seeding, bracket flow and time corrections |

## Setup (Supabase + GitHub Pages)

The site is static HTML/JS with no build step. Supabase holds all the data, and every page stays in sync through Supabase Realtime.

1. **Database:** in the Supabase dashboard open **SQL editor**, paste all of [`supabase/schema.sql`](supabase/schema.sql) and run it. Then set the shared admin password:
   ```sql
   select private.set_admin_password('pick-a-long-passphrase');
   ```
   Run that again any time to change it. Re-running `schema.sql` wipes all data and starts fresh.
2. **Keys:** `static/js/config.js` holds the project URL and the publishable key. Both are public by design: the key can only read, and every change needs the admin password.
3. **Hosting:** in the GitHub repo go to Settings → Pages → Build and deployment, choose **Deploy from a branch**, then branch `main`, folder `/ (root)`. The site goes live at
   - audience: `https://preesha07.github.io/ZipIt-finals-website/`
   - admin: `https://preesha07.github.io/ZipIt-finals-website/admin/`

To try it locally, serve the folder with any static server, e.g. `python3 -m http.server`, and open `http://localhost:8000/`. It still uses the live Supabase project.

**How it's secured:** the tables are readable by anyone but not writable. All changes go through the `zipit_action(password, action)` database function. It checks the password against a bcrypt hash in a private schema that the API can't read, and a wrong guess gets a delay.

**The 10-minute stop:** there's no always-on server. When any open page sees the clock reach zero, it asks the database to apply the stop, and every admin action checks for it too. The recorded end is always exactly 10:00.000.

## On a phone

Everything stacks into one column. On the admin, a **Both / A / B** switch at the top shows just one team. Two operators can then each run a team from their own phone, with the big buttons right under the team name. The bracket scrolls sideways at a readable size.

## Tournament flow

1. **Seed:** add teams in seed order (best first), or paste them under **Bulk import** as `Team name, headstart seconds`. Use ▲▼ to reorder. The list order is the seeding.
2. **Generate bracket:** standard single-elimination pairing by recursive bracket order (1v16, 8v9, 4v13, 5v12, …), so seeds 1 and 2 can only meet in the final. If the team count isn't a power of two, the top seeds get byes. Seeds lock once the bracket exists. **Reset tournament** (Settings & data) unlocks them and deletes all matches and attempts.
3. **Start Round of N:** loads the round's first match. Its matches run top to bottom.
4. **Finish match…:** pick who goes through (the better best score is preselected). Any run still in progress is saved first, and the next match loads.
5. After the round's last match, both screens show the **bracket**. Played matches are in colour and the winner flows on with a green arrow. Upcoming matches are grey, with `?` for teams not decided yet. **Proceed to Round of N/2** starts the next round.
6. The last column holds the final standings: 1 is the champion, 2 is the runner-up, and 3 and 4 are the semi-final losers, ordered by their semi-final best score. After the final, the audience screen celebrates.

**Show bracket** / **Back to match** switches both screens between the bracket and the live match at any time.

## The timer (admin)

Each team has its own iPhone-style lap timer:

| State | Left button | Right button |
| --- | --- | --- |
| Ready | Checkpoint (disabled) | **Start** |
| Running | **Checkpoint**: ends the current lap (split saved), next one starts | **Stop**: pauses the current lap |
| Paused | **Reset**: saves this attempt and starts a fresh one | **Start**: resumes the same lap |
| Run complete (last checkpoint reached) | **Reset**: saves it, new attempt | (locked) |

- **Checkpoints this match** (header, − / +): the course length for the current match. Reaching the last checkpoint ends the run automatically. A new round starts with the previous match's value, and a new bracket starts with the default from Settings.
- The 10-minute match clock starts with the first Start of either team. At 0:00 both timers stop on their own, any unfinished attempt is saved, and the controls lock.
- Keyboard (laptop): team A `Q` (checkpoint/reset) and `W` (start/stop), team B `O` and `P`. Buttons fire on press, not release.
- **Undo last checkpoint** folds an accidental split back into the current lap.
- **Editing times:** click a split in the current attempt to correct its splits. Click a saved attempt (the chips under Overall) to edit its splits and total time, or delete it. Edited attempts get a ✎.
- **Pause everything** freezes the match clock and both robots. **Restart match** discards the match's attempts (kept in the CSV as voided).

### Scoring

**Score = time to the last checkpoint reached − headstart (seconds).** Lower is better. Attempts that reach more checkpoints (up to the course length) always rank above ones that reach fewer. Each team's best attempt in the match is shown under **Overall**, and it drives the winner suggestion. The rule lives in `private.best_json()` in `supabase/schema.sql` and `better()` in `static/js/admin.js` + `static/js/bracket.js`.

## Data

- **Settings & data:** match length (default 10 min), default checkpoints, the attempts CSV (splits, time, headstart, score), reset tournament, lock console.
- All state, including running timers, lives in Supabase, so refreshing or switching devices never loses time.

## Layout

```
index.html              audience page
admin/index.html        operator page
supabase/schema.sql     tables, security, and every rule (run once in the SQL editor)
static/js/config.js     Supabase URL + publishable key
static/js/core.js       Supabase connection, clock sync, formatting
static/js/view.js       shared board rendering
static/js/track.js      kart track animation
static/js/bracket.js    knockout tree (SVG)
static/js/display.js    audience logic
static/js/admin.js      operator logic
static/css/zipit.css    "Comic Circuit" theme from the ZipIT site
legacy/server.py        the old self-hosted Python server (not used by the site any more)
```

Fonts come from Google Fonts and supabase-js from jsDelivr. Without internet nothing works anyway, since the data is in Supabase.
