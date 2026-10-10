// Admin console: iPhone-style lap timers for both teams, seeding, bracket flow, time corrections.
import { connect, esc, fmtHead, fmtLap, fmtSigned, parseTime, roundName, sb, serverNow, sum, tickIfDue } from './core.js';
import {
  SIDES, frameHeader, frameTeams, headerHTML, outTag, rosterHTML, rosterRowClass, updateHeader, updateTeams, versusHTML, viewOf,
} from './view.js';
import { mountBracket } from './bracket.js';

const KEY_STORE = 'zipit-admin-key';
const KEYS = { A: { left: 'q', right: 'w' }, B: { left: 'o', right: 'p' } };

let key = '';
try { key = localStorage.getItem(KEY_STORE) || ''; } catch { /* storage blocked */ }
let state = null;
let live = null;

const controlsHTML = (side) => `
  <div class="panel controls" data-controls="${side}">
    <button type="button" class="ios-btn ios-lap" data-act="left" disabled>Checkpoint</button>
    <div class="ctrl-mid">
      <span class="tm" data-ctrl-state>Ready</span>
      <span class="kbd-hint">Keys <kbd>${KEYS[side].left.toUpperCase()}</kbd> <kbd>${KEYS[side].right.toUpperCase()}</kbd></span>
      <button type="button" class="linkish" data-act="undo" disabled>Undo last checkpoint</button>
    </div>
    <button type="button" class="ios-btn ios-start" data-act="right" disabled>Start</button>
  </div>`;

const matchTools = `
  <div class="match-tools panel" id="match-tools">
    <div class="cp-field">
      <span class="tm">Checkpoints this match</span>
      <div class="stepper">
        <button type="button" data-cp="-1" aria-label="One fewer checkpoint">−</button>
        <input id="cp-input" type="number" min="1" max="30" inputmode="numeric" aria-label="Checkpoints this match">
        <button type="button" data-cp="1" aria-label="One more checkpoint">+</button>
      </div>
    </div>
    <div class="clock-tools" id="clock-tools"></div>
  </div>`;

document.getElementById('app').innerHTML = `
  <div class="stage" id="stage">
    ${rosterHTML({ collapsible: true })}
    <main class="arena">
      ${headerHTML(matchTools)}
      <div class="body-slot">
        <div class="side-filter" id="side-filter" aria-label="Show which team">
          <button type="button" data-only="">Both</button><button type="button" data-only="A">Team A</button><button type="button" data-only="B">Team B</button>
        </div>
        ${versusHTML(controlsHTML('A'), controlsHTML('B'))}
        <section class="panel bracket-panel" id="bracket" hidden><div class="bracket-wrap" id="bracket-wrap"></div></section>
        <section class="panel splash" id="splash" hidden>
          <h2>Seed the teams</h2>
          <p>Order on the left is the seeding (▲▼ to move). Seed 1 meets the lowest seed, and so on.<br>Top seeds get byes when the count isn't a power of two.</p>
          <button type="button" class="abtn abtn-primary abtn-hero" data-act-main="bracket.generate">Generate bracket</button>
        </section>
      </div>
      <footer class="admin-foot" id="foot"></footer>
    </main>
  </div>

  <dialog id="key-dlg">
    <form class="panel dlg" id="key-form">
      <h2>Admin password</h2>
      <p class="muted" style="margin:0">The shared password set in Supabase with <code>private.set_admin_password</code>.</p>
      <input class="field" id="key-input" type="password" autocomplete="current-password" required>
      <p class="error" id="key-error"></p>
      <div class="dlg-actions"><button class="abtn abtn-primary" type="submit">Unlock</button></div>
    </form>
  </dialog>

  <dialog id="finish-dlg">
    <form class="panel dlg" id="finish-form">
      <h2>Finish match</h2>
      <fieldset><legend>Who goes through?</legend><div id="winner-choices"></div></fieldset>
      <p class="muted" id="finish-next" style="margin:0"></p>
      <div class="dlg-actions">
        <button class="abtn abtn-ghost" type="button" data-close>Cancel</button>
        <button class="abtn abtn-primary" type="submit">Confirm winner</button>
      </div>
    </form>
  </dialog>

  <dialog id="edit-dlg">
    <form class="panel dlg" id="edit-form">
      <h2 id="edit-title">Edit times</h2>
      <p class="muted" style="margin:0">Type times as <b>mm:ss.cc</b> (or just seconds).</p>
      <div class="edit-grid" id="edit-grid"></div>
      <p class="error" id="edit-error"></p>
      <div class="dlg-actions">
        <button class="abtn abtn-ghost" type="button" id="edit-delete" hidden>Delete attempt</button>
        <span style="flex:1"></span>
        <button class="abtn abtn-ghost" type="button" data-close>Cancel</button>
        <button class="abtn abtn-primary" type="submit">Save</button>
      </div>
    </form>
  </dialog>`;

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- server calls ----------

async function act(type, extra = {}) {
  let res;
  try {
    res = await sb.rpc('zipit_action', { p_key: key, p_action: { type, at: Math.round(serverNow()), ...extra } });
  } catch {
    res = { error: { message: 'Can\'t reach Supabase. Check the internet connection.' } };
  }
  const { data, error } = res;
  if (error) {
    if (error.code === 'ZA403') { askKey(error.message); return false; }
    toast(/fetch|network/i.test(error.message) ? 'Can\'t reach Supabase. Check the internet connection.' : error.message, true);
    // the failed call may still have applied a due 10-minute stop
    live.refresh();
    return false;
  }
  live.push(data);
  return true;
}

let toastTimer;
function toast(msg, err = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.role = 'status';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

function askKey(msg = '') {
  const dlg = $('#key-dlg');
  $('#key-error').textContent = msg;
  if (!dlg.open) dlg.showModal();
  $('#key-input').focus();
}

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  key = $('#key-input').value;
  if (await act('ping')) {
    try { localStorage.setItem(KEY_STORE, key); } catch { /* fine */ }
    $('#key-dlg').close();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
  const main = e.target.closest('[data-act-main]');
  if (main) {
    const type = main.dataset.actMain;
    if (type === 'tournament.reset' && !confirm('Reset the whole tournament?\n\nThe bracket, every match and every attempt are deleted. Teams and seeds stay.')) return;
    if (type === 'match.restart' && !confirm('Restart this match?\n\nEvery attempt in it is discarded and the clock goes back to the start.')) return;
    if (type === 'finish') return openFinish();
    act(type, main.dataset.view ? { view: main.dataset.view } : {});
  }
});

// ---------- stopwatch controls ----------

function buttonModel(w, over) {
  const locked = { left: ['Checkpoint', 'ios-lap', null], right: ['Start', 'ios-start', null] };
  if (!state?.match) return { ...locked, label: 'Locked' };
  if (w.status === 'done' || (over && w.status !== 'complete')) return { ...locked, label: 'Time up' };
  switch (w.status) {
    case 'idle': return { left: ['Checkpoint', 'ios-lap', null], right: ['Start', 'ios-start', 'watch.start'], label: 'Ready' };
    case 'running': return { left: ['Checkpoint', 'ios-lap', 'watch.lap'], right: ['Stop', 'ios-stop', 'watch.stop'], label: 'Running' };
    case 'paused': return { left: ['Reset<small>save · new attempt</small>', 'ios-reset', 'watch.reset'], right: ['Start<small>resume</small>', 'ios-start', 'watch.start'], label: 'Paused' };
    case 'complete': return { left: ['Reset<small>save · new attempt</small>', 'ios-reset', 'watch.reset'], right: ['Finished', 'ios-start', null], label: 'Run complete' };
  }
}

const STATE_CLS = { Running: 'tm-live', 'Run complete': 'tm-live', Paused: 'tm-warn', 'Time up': 'tm-red', Locked: 'tm-dim' };

function updateControls() {
  if (!state.match) return;
  for (const side of SIDES) {
    const box = $(`[data-controls="${side}"]`);
    const w = state.match.sides[side].watch;
    const m = buttonModel(w, state.clock.over);
    for (const pos of ['left', 'right']) {
      const btn = $(`[data-act="${pos}"]`, box);
      const [label, cls, action] = m[pos];
      btn.className = `ios-btn ${cls}`;
      btn.innerHTML = label;
      btn.disabled = !action;
      btn.dataset.action = action || '';
    }
    const st = $('[data-ctrl-state]', box);
    st.textContent = m.label;
    st.className = `tm ${STATE_CLS[m.label] || ''}`;
    $('[data-act="undo"]', box).disabled = !(w.laps.length && ['running', 'paused', 'complete'].includes(w.status));
  }
}

function press(side, pos) {
  const btn = $(`[data-controls="${side}"] [data-act="${pos}"]`);
  if (viewOf(state) !== 'match' || btn.disabled || !btn.dataset.action) return;
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 120);
  act(btn.dataset.action, { side });
}

for (const side of SIDES) {
  const box = $(`[data-controls="${side}"]`);
  // pointerdown, not click: a checkpoint should be stamped the instant the finger lands.
  for (const pos of ['left', 'right']) {
    const btn = $(`[data-act="${pos}"]`, box);
    btn.addEventListener('pointerdown', (e) => { if (e.button === 0) press(side, pos); });
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); press(side, pos); } });
  }
  $('[data-act="undo"]', box).addEventListener('click', () => act('watch.undo', { side }));
}

document.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  for (const side of SIDES) {
    if (k === KEYS[side].left) { e.preventDefault(); press(side, 'left'); }
    if (k === KEYS[side].right) { e.preventDefault(); press(side, 'right'); }
  }
});

// ---------- checkpoints field & clock ----------

const cpInput = $('#cp-input');
function setCheckpoints(n) {
  if (!Number.isInteger(n) || n === state.match?.checkpoints) return;
  act('match.checkpoints', { n }).then((ok) => { if (!ok) cpInput.value = state.match.checkpoints; });
}
cpInput.addEventListener('change', () => setCheckpoints(Number(cpInput.value)));
cpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') cpInput.blur(); });
$('#match-tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cp]');
  if (b) setCheckpoints(state.match.checkpoints + Number(b.dataset.cp));
  const c = e.target.closest('[data-clock]');
  if (c) act(`clock.${c.dataset.clock}`);
});

function updateMatchTools() {
  const tools = $('#match-tools');
  tools.hidden = viewOf(state) !== 'match';
  if (tools.hidden) return;
  if (document.activeElement !== cpInput) cpInput.value = state.match.checkpoints;
  const c = state.clock;
  let html = '';
  if (!c.over) {
    html = c.since != null
      ? '<button type="button" class="abtn abtn-sm abtn-ghost" data-clock="pause" title="Freeze the match clock and both robots">Pause everything</button>'
      : `<button type="button" class="abtn abtn-sm abtn-primary" data-clock="start">${c.accum ? 'Resume clock' : 'Start clock'}</button>`;
  }
  const ct = $('#clock-tools');
  if (ct.dataset.html !== html) { ct.innerHTML = html; ct.dataset.html = html; }
}

// ---------- attempt history (overall strip) ----------

function updateHistory() {
  if (!state.match) return;
  for (const side of SIDES) {
    const col = $(`.team-col[data-side="${side}"]`);
    const s = state.match.sides[side];
    let el = $('.overall-history', col);
    if (!el) {
      el = document.createElement('div');
      el.className = 'history overall-history';
      $('.overall', col).appendChild(el);
    }
    el.innerHTML = s.attempts.length
      ? s.attempts.map((a) => {
        const isBest = s.best && a.id === s.best.id;
        return `<button type="button" class="${isBest ? 'is-best' : ''}" data-edit-attempt="${a.id}" data-side="${side}" title="Edit attempt ${a.no}">#${a.no} ${a.checkpoints}/${state.match.checkpoints} ${fmtSigned(a.scoreMs)}${a.edited ? ' ✎' : ''}</button>`;
      }).join('')
      : '<span class="muted">Saved attempts appear here. Click one to edit its times.</span>';
  }
}

// ---------- edit times dialog ----------

let editing = null;

function openEdit(target) {
  editing = target;
  const team = state.teams.find((t) => t.id === state.match.sides[target.side].teamId);
  editing.headstart = team?.headstart ?? 0;
  $('#edit-title').textContent = target.kind === 'live' ? 'Edit current attempt' : `Edit attempt #${target.attempt.no}`;
  let html = target.laps.map((ms, i) => `
    <label><span class="field-label">CP ${i + 1} split</span><input class="field mono" data-split="${i}" data-ms="${ms}" value="${fmtLap(ms)}"></label>`).join('');
  if (!target.laps.length) html += '<p class="span muted">No checkpoints in this attempt.</p>';
  if (target.kind === 'attempt') {
    html += `<label class="span"><span class="field-label">Total attempt time (includes the unfinished lap)</span><input class="field mono" id="edit-total" data-ms="${target.attempt.totalMs}" value="${fmtLap(target.attempt.totalMs)}"></label>`;
  }
  html += `<p class="span edit-sum">Time to last checkpoint <b class="mono" id="edit-run"></b> − headstart ${fmtHead(editing.headstart)} = score <b class="mono" id="edit-score"></b></p>`;
  $('#edit-grid').innerHTML = html;
  $('#edit-delete').hidden = target.kind !== 'attempt';
  $('#edit-error').textContent = '';
  updateEditSum();
  $('#edit-dlg').showModal();
}

/** Untouched fields keep their exact ms; the display rounds to hundredths. */
function readTime(input) {
  return input.value === input.defaultValue ? Number(input.dataset.ms) : parseTime(input.value);
}

function readSplits() {
  return [...document.querySelectorAll('#edit-grid [data-split]')].map(readTime);
}

function updateEditSum() {
  const splits = readSplits();
  const ok = splits.every((x) => Number.isFinite(x));
  const run = sum(splits);
  $('#edit-run').textContent = ok ? fmtLap(run) : '?';
  $('#edit-score').textContent = ok ? fmtSigned(run - Math.round(editing.headstart * 1000)) : '?';
}

$('#edit-grid').addEventListener('input', updateEditSum);

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const laps = readSplits();
  if (!laps.every((x) => Number.isFinite(x))) { $('#edit-error').textContent = 'One of the times isn\'t a valid mm:ss.cc.'; return; }
  let ok;
  if (editing.kind === 'live') {
    ok = await act('watch.edit', { side: editing.side, laps });
  } else {
    const total = readTime($('#edit-total'));
    if (!Number.isFinite(total)) { $('#edit-error').textContent = 'Total time isn\'t a valid mm:ss.cc.'; return; }
    if (total < sum(laps)) { $('#edit-error').textContent = 'Total can\'t be shorter than the splits added up.'; return; }
    ok = await act('attempt.edit', { id: editing.attempt.id, laps, totalMs: total });
  }
  if (ok) $('#edit-dlg').close();
});

$('#edit-delete').addEventListener('click', async () => {
  if (!confirm(`Delete attempt #${editing.attempt.no}? It no longer counts towards the best score.`)) return;
  if (await act('attempt.delete', { id: editing.attempt.id })) $('#edit-dlg').close();
});

function openLiveEdit(side) {
  openEdit({ kind: 'live', side, laps: [...state.match.sides[side].watch.laps] });
}

$('#versus').addEventListener('click', (e) => {
  const liveRow = e.target.closest('[data-edit-live]');
  if (liveRow) return openLiveEdit(liveRow.dataset.editLive);
  const chip = e.target.closest('[data-edit-attempt]');
  if (chip) {
    const side = chip.dataset.side;
    const attempt = state.match.sides[side].attempts.find((a) => a.id === Number(chip.dataset.editAttempt));
    if (attempt) openEdit({ kind: 'attempt', side, attempt, laps: [...attempt.laps] });
  }
});
$('#versus').addEventListener('keydown', (e) => {
  const liveRow = e.target.closest('[data-edit-live]');
  if (liveRow && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLiveEdit(liveRow.dataset.editLive); }
});

// ---------- finish match dialog ----------

const better = (a, b, n) => {
  if (!a) return false;
  if (!b) return true;
  const ca = Math.min(a.checkpoints, n);
  const cb = Math.min(b.checkpoints, n);
  return ca > cb || (ca === cb && a.scoreMs < b.scoreMs);
};

function openFinish() {
  const m = state.match;
  if (!m) return;
  const [a, b] = SIDES.map((s) => m.sides[s]);
  const n = m.checkpoints;
  const suggest = better(a.best, b.best, n) ? 'A' : better(b.best, a.best, n) ? 'B' : '';
  const name = (s) => state.teams.find((t) => t.id === s.teamId)?.name ?? '?';
  const running = SIDES.some((s) => ['running', 'paused', 'complete'].includes(m.sides[s].watch.status));
  const choice = (val, s) => `
    <label class="choice"><input type="radio" name="winner" value="${val}" ${val === suggest ? 'checked' : ''} required>
      <span class="grow">${esc(name(s))}${val === suggest ? ' <span class="tm tm-live">best score</span>' : ''}</span>
      <span class="mono">${s.best ? `${s.best.checkpoints}/${n} CP · ${fmtSigned(s.best.scoreMs)}` : 'no saved attempts'}</span></label>`;
  $('#winner-choices').innerHTML = choice('A', a) + choice('B', b);
  const last = m.matchNo === m.matchCount;
  $('#finish-next').textContent = (running ? 'Runs still in progress get saved as attempts when you confirm (the suggestion above only counts saved ones). ' : '') +
    (last ? `This is the last match of the ${roundName(m.round)[0]}: the bracket shows next.` : `Match ${m.matchNo + 1} of ${m.matchCount} loads next.`);
  $('#finish-dlg').showModal();
}

$('#finish-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const winner = $('#winner-choices input:checked')?.value;
  if (!winner) return;
  if (await act('match.finish', { winner })) $('#finish-dlg').close();
});

// ---------- footer ----------

function updateFooter() {
  const view = viewOf(state);
  const t = state.tournament;
  const btn = (label, type, cls = 'abtn-ghost', extra = '') => `<button type="button" class="abtn ${cls}" data-act-main="${type}" ${extra}>${label}</button>`;
  let html = '';
  if (view === 'setup') {
    html = ''; // the splash carries the Generate bracket button
  } else if (view === 'match') {
    html = btn('Show bracket', 'view.set', 'abtn-ghost', 'data-view="bracket"') +
      btn('Restart match', 'match.restart', 'abtn-danger') +
      btn('Finish match…', 'finish', 'abtn-primary abtn-hero');
  } else if (t.champion != null) {
    html = '<span class="tm tm-live">Tournament complete</span>';
  } else if (state.match) {
    html = btn('Back to match', 'view.set', 'abtn-primary abtn-hero', 'data-view="match"');
  } else if (t.roundOver) {
    html = btn(`Proceed to ${roundName(t.round / 2)[0]} →`, 'round.proceed', 'abtn-primary abtn-hero');
  } else {
    html = btn(`Start ${roundName(t.round)[0]} →`, 'round.proceed', 'abtn-primary abtn-hero');
  }
  html += '<a class="tm" href="../" target="_blank" rel="noopener">Audience display ↗</a>';
  const foot = $('#foot');
  if (foot.dataset.html !== html) { foot.innerHTML = html; foot.dataset.html = html; }
}

// ---------- roster (editable) ----------

$('#collapse').addEventListener('click', () => {
  const stage = $('#stage');
  stage.classList.toggle('roster-collapsed');
  const collapsed = stage.classList.contains('roster-collapsed');
  $('#collapse').textContent = collapsed ? '»' : '«';
  $('#collapse').setAttribute('aria-label', collapsed ? 'Expand team list' : 'Collapse team list');
});

$('#roster-extra').className = 'roster-extra';
$('#roster-extra').innerHTML = `
  <details class="side-box">
    <summary>Add team</summary>
    <form class="form-row" id="add-form">
      <input class="field" name="name" placeholder="Team name" required maxlength="60">
      <input class="field" name="headstart" placeholder="Headstart (s)" inputmode="decimal" style="max-width:110px">
      <button class="abtn abtn-sm abtn-primary" type="submit">Add</button>
    </form>
  </details>
  <details class="side-box">
    <summary>Bulk import</summary>
    <textarea class="field" id="bulk-text" placeholder="One per line, best seed first:&#10;Team name, headstart seconds"></textarea>
    <div class="form-row"><button class="abtn abtn-sm abtn-primary" type="button" id="bulk-btn">Import</button><span class="field-label">Existing names get their headstart updated.</span></div>
  </details>
  <details class="side-box">
    <summary>Settings &amp; data</summary>
    <form id="settings-form">
      <div class="form-row"><span class="field-label" style="flex:1">Match length (minutes)</span><input class="field" name="minutes" type="number" min="0.5" max="60" step="0.5" style="max-width:90px"></div>
      <div class="form-row"><span class="field-label" style="flex:1">Default checkpoints for a new bracket</span><input class="field" name="cps" type="number" min="1" max="30" style="max-width:90px"></div>
      <div class="form-row"><button class="abtn abtn-sm abtn-primary" type="submit">Save settings</button></div>
    </form>
    <div class="form-row">
      <a class="abtn abtn-sm abtn-ghost" id="export-link" href="#">Attempts CSV</a>
      <button class="abtn abtn-sm abtn-danger" type="button" data-act-main="tournament.reset">Reset tournament</button>
      <button class="linkish" type="button" id="forget-key">Lock console</button>
    </div>
  </details>`;

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (await act('teams.add', { name: f.name.value, headstart: f.headstart.value })) {
    f.reset();
    f.name.focus();
  }
});

$('#bulk-btn').addEventListener('click', async () => {
  if (await act('teams.bulk', { text: $('#bulk-text').value })) {
    $('#bulk-text').value = '';
    toast('Teams imported.');
  }
});

$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  act('settings.update', { matchDurationMs: Math.round(Number(f.minutes.value) * 60000), defaultCheckpoints: Number(f.cps.value) })
    .then((ok) => ok && toast('Settings saved.'));
});

$('#forget-key').addEventListener('click', () => {
  try { localStorage.removeItem(KEY_STORE); } catch { /* fine */ }
  key = '';
  askKey();
});

$('#export-link').addEventListener('click', async (e) => {
  e.preventDefault();
  const { data, error } = await sb.from('attempts')
    .select('id, attempt_no, laps, partial_ms, end_reason, edited, voided, created_at, matches(round, slot), teams(name, headstart)')
    .order('id');
  if (error) { toast(error.message, true); return; }
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [['attempt_id', 'round', 'match_slot', 'team', 'headstart_s', 'attempt_no', 'checkpoints', 'time_ms', 'score_ms',
    'total_ms', 'laps_ms', 'end_reason', 'edited', 'voided', 'created_at']];
  for (const a of data) {
    const run = sum(a.laps);
    const head = Number(a.teams.headstart);
    rows.push([a.id, a.matches.round, a.matches.slot + 1, a.teams.name, head, a.attempt_no, a.laps.length, run,
      run - Math.round(head * 1000), run + a.partial_ms, a.laps.join(' '), a.end_reason, a.edited, a.voided,
      new Date(a.created_at).toISOString()]);
  }
  const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'zipit-finals-attempts.csv' });
  link.click();
  URL.revokeObjectURL(link.href);
});

let rosterKey = '';
let rosterPending = false;
const list = $('#roster-list');

function renderRoster() {
  const locked = state.tournament.size != null;
  const k = JSON.stringify([state.teams, state.match?.sides.A.teamId, state.match?.sides.B.teamId, locked]);
  if (k === rosterKey) return;
  if (list.contains(document.activeElement) && document.activeElement.matches('input')) { rosterPending = true; return; }
  rosterKey = k;
  rosterPending = false;
  if (!state.teams.length) {
    list.innerHTML = '<li class="roster-empty">No teams yet. Add them below, best seed first.</li>';
    return;
  }
  const last = state.teams.length - 1;
  list.innerHTML = state.teams.map((t, i) => `
    <li class="team-row edit ${rosterRowClass(state, t)}" data-id="${t.id}">
      <span class="seed">${t.seed}</span>
      <input data-field="name" value="${esc(t.name)}" aria-label="Team name" maxlength="60">
      <label class="hs-in"><input class="th" data-field="headstart" value="${t.headstart || 0}" inputmode="decimal" aria-label="Headstart seconds for ${esc(t.name)}"><span>s</span></label>
      <span class="row-tools">
        ${locked ? '' : `<button type="button" data-move="-1" title="Seed up" aria-label="Move ${esc(t.name)} up" ${i === 0 ? 'disabled' : ''}>▲</button><button type="button" data-move="1" title="Seed down" aria-label="Move ${esc(t.name)} down" ${i === last ? 'disabled' : ''}>▼</button>`}
        <button type="button" data-del title="Delete team" aria-label="Delete ${esc(t.name)}">✕</button>
      </span>
      ${outTag(t)}
    </li>`).join('');
}

list.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-field]');
  if (!input) return;
  const id = Number(input.closest('[data-id]').dataset.id);
  act('teams.update', { id, [input.dataset.field]: input.value }).then((ok) => {
    if (!ok) { input.value = input.defaultValue; rosterKey = ''; rosterPending = true; }
  });
});
list.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
  if (e.key === 'Escape' && e.target.matches('input')) {
    e.target.value = e.target.defaultValue; // revert, so blurring doesn't commit the edit
    e.target.blur();
  }
});
list.addEventListener('focusout', () => {
  setTimeout(() => { if (rosterPending && !list.contains(document.activeElement)) renderRoster(); }, 0);
});
list.addEventListener('click', (e) => {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  const id = Number(row.dataset.id);
  const team = state.teams.find((t) => t.id === id);
  const move = e.target.closest('[data-move]');
  if (move) act('teams.move', { id, dir: Number(move.dataset.move) });
  if (e.target.closest('[data-del]') && confirm(`Delete ${team.name}?`)) act('teams.delete', { id });
});

function renderSettings() {
  const f = $('#settings-form');
  if (!f.contains(document.activeElement)) {
    f.minutes.value = state.settings.matchDurationMs / 60000;
    f.cps.value = state.settings.defaultCheckpoints;
  }
}

// ---------- bracket ----------

const bracket = mountBracket($('#bracket-wrap'));

// ---------- phone: show one team or both ----------

const ONLY_STORE = 'zipit-admin-only';
function setOnly(side) {
  const versus = $('#versus');
  if (side) versus.dataset.only = side; else delete versus.dataset.only;
  for (const b of document.querySelectorAll('#side-filter button')) b.setAttribute('aria-pressed', String(b.dataset.only === side));
  try { localStorage.setItem(ONLY_STORE, side); } catch { /* fine */ }
}
$('#side-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-only]');
  if (b) setOnly(b.dataset.only);
});
let only = '';
try { only = localStorage.getItem(ONLY_STORE) || ''; } catch { /* fine */ }
setOnly(only);

function updateSideFilter() {
  $('#side-filter').hidden = viewOf(state) !== 'match';
  if (!state.match) return;
  for (const side of SIDES) {
    const name = state.teams.find((t) => t.id === state.match.sides[side].teamId)?.name ?? `Team ${side}`;
    const b = $(`#side-filter [data-only="${side}"]`);
    b.textContent = `${side} · ${name}`;
    b.title = name;
  }
}

// ---------- main loop ----------

function render(next) {
  state = next;
  const view = viewOf(state);
  renderRoster();
  renderSettings();
  updateHeader(state);
  $('#versus').hidden = view !== 'match';
  $('#bracket').hidden = view !== 'bracket';
  $('#splash').hidden = view !== 'setup';
  if (view === 'bracket') bracket.update(state); else bracket.reset();
  if (state.match) {
    updateTeams(state, { editable: true });
    updateControls();
    updateHistory();
  }
  updateMatchTools();
  updateSideFilter();
  updateFooter();
}

function loop() {
  if (state && viewOf(state) === 'match') {
    frameHeader(state);
    frameTeams(state);
    tickIfDue(state);
  }
  requestAnimationFrame(loop);
}

live = connect(render, (ok) => { $('#conn').hidden = ok; });
requestAnimationFrame(loop);
if (!key) askKey(); else act('ping');
