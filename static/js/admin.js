// Admin console: iPhone-style lap timers for both teams, team list, match flow.
import { ROUND_NAMES, connect, esc, fmtLap, serverNow } from './core.js';
import {
  SIDES, frameHeader, frameTeams, headerHTML, rosterHTML, updateHeader, updateTeams, versusHTML,
} from './view.js';

const KEY_STORE = 'zipit-admin-key';
const KEYS = { A: { left: 'q', right: 'w' }, B: { left: 'o', right: 'p' } };
const ROUNDS = [16, 8, 4, 2];

let key = '';
try { key = localStorage.getItem(KEY_STORE) || ''; } catch { /* storage blocked */ }
let state = null;
let live = null;

const controlsHTML = (side) => `
  <div class="panel controls" data-controls="${side}">
    <div class="ctrl-row">
      <button type="button" class="ios-btn ios-lap" data-act="left" disabled>Checkpoint</button>
      <div class="ctrl-mid">
        <span class="tm" data-ctrl-state>Ready</span>
        <span class="kbd-hint">Keys <kbd>${KEYS[side].left.toUpperCase()}</kbd> <kbd>${KEYS[side].right.toUpperCase()}</kbd></span>
      </div>
      <button type="button" class="ios-btn ios-start" data-act="right" disabled>Start</button>
    </div>
    <div class="ctrl-foot">
      <button type="button" class="linkish" data-act="undo" disabled>Undo last checkpoint</button>
      <span class="kbd-hint muted" data-ctrl-hint></span>
    </div>
  </div>`;

document.getElementById('app').innerHTML = `
  <div class="stage" id="stage">
    ${rosterHTML({ collapsible: true })}
    <main class="arena">
      ${headerHTML('<div class="clock-tools" id="clock-tools"></div>')}
      <div id="body-slot">
        ${versusHTML(controlsHTML('A'), controlsHTML('B'))}
        <section class="panel splash" id="splash" hidden>
          <h2>No match running</h2>
          <p>Add teams on the left, then set up the first match.</p>
          <button type="button" class="abtn abtn-primary abtn-hero" data-open-next>Set up match</button>
        </section>
      </div>
      <footer class="admin-foot">
        <button type="button" class="abtn abtn-ghost" id="edit-btn">Edit pairing</button>
        <button type="button" class="abtn abtn-danger abtn-hero" id="restart-btn">Restart match</button>
        <button type="button" class="abtn abtn-primary abtn-hero" id="next-btn" data-open-next>Next match</button>
        <a class="tm" href="/" target="_blank" rel="noopener">Audience display ↗</a>
      </footer>
    </main>
  </div>

  <dialog id="key-dlg">
    <form class="panel dlg" method="dialog" id="key-form">
      <h2>Admin key</h2>
      <p class="muted" style="margin:0">Enter the key the server was started with (ZIPIT_ADMIN_KEY).</p>
      <input class="field" id="key-input" type="password" autocomplete="current-password" required>
      <p class="error" id="key-error"></p>
      <div class="dlg-actions"><button class="abtn abtn-primary" type="submit">Unlock</button></div>
    </form>
  </dialog>

  <dialog id="next-dlg">
    <form class="panel dlg" id="next-form">
      <h2 id="next-title">Next match</h2>
      <fieldset id="winner-set"><legend>Result of this match</legend><div id="winner-choices"></div></fieldset>
      <fieldset id="pairing-set">
        <legend id="pairing-legend">Next pairing</legend>
        <div class="dlg-grid">
          <label class="span"><span class="field-label">Round</span><select class="field" id="next-round">${ROUNDS.map((r) => `<option value="${r}">${ROUND_NAMES[r][0]} (${ROUND_NAMES[r][1]})</option>`).join('')}</select></label>
          <label><span class="field-label">Team A (red)</span><select class="field" id="next-a"></select></label>
          <label><span class="field-label">Team B (gold)</span><select class="field" id="next-b"></select></label>
        </div>
        <label class="choice" id="no-next-row"><input type="checkbox" id="no-next"><span class="grow">No next match (tournament over / break)</span></label>
      </fieldset>
      <p class="error" id="next-error"></p>
      <div class="dlg-actions">
        <button class="abtn abtn-ghost" type="button" id="next-cancel">Cancel</button>
        <button class="abtn abtn-primary" type="submit" id="next-submit">Go</button>
      </div>
    </form>
  </dialog>`;

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- server calls ----------

async function act(type, extra = {}) {
  let res;
  try {
    res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ type, at: Math.round(serverNow()), ...extra }),
    });
  } catch {
    toast('Server unreachable. Check the laptop running server.py.', true);
    return false;
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) { askKey('That key was rejected.'); return false; }
  if (body.state) live.push(body.state);
  if (!res.ok) { toast(body.error || 'Something went wrong.', true); return false; }
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
  const ok = await act('ping');
  if (ok) {
    try { localStorage.setItem(KEY_STORE, key); } catch { /* fine */ }
    $('#key-dlg').close();
  }
});

// ---------- stopwatch controls ----------

function buttonModel(w, over) {
  if (!state?.match || over || w.status === 'done') {
    return { left: ['Checkpoint', 'ios-lap', null], right: ['Start', 'ios-start', null], label: over ? 'Time up' : 'Locked' };
  }
  switch (w.status) {
    case 'idle': return { left: ['Checkpoint', 'ios-lap', null], right: ['Start', 'ios-start', 'watch.start'], label: 'Ready' };
    case 'running': return { left: ['Checkpoint', 'ios-lap', 'watch.lap'], right: ['Stop', 'ios-stop', 'watch.stop'], label: 'Running' };
    case 'paused': return { left: ['Reset<small>save · new attempt</small>', 'ios-reset', 'watch.reset'], right: ['Start<small>resume</small>', 'ios-start', 'watch.start'], label: 'Paused' };
  }
}

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
    $('[data-ctrl-state]', box).textContent = m.label;
    $('[data-ctrl-state]', box).className = `tm ${{ Running: 'tm-live', Paused: 'tm-warn', 'Time up': 'tm-red', Locked: 'tm-dim' }[m.label] || ''}`;
    $('[data-act="undo"]', box).disabled = !(w.laps.length && (w.status === 'running' || w.status === 'paused'));
    $('[data-ctrl-hint]', box).textContent = w.status === 'paused' ? 'Reset saves this attempt' : '';
  }
}

function press(side, pos) {
  const box = $(`[data-controls="${side}"]`);
  const btn = $(`[data-act="${pos}"]`, box);
  if (btn.disabled || !btn.dataset.action) return;
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

// ---------- overall: attempt history ----------

function updateHistory() {
  if (!state.match) return;
  for (const side of SIDES) {
    const col = $(`.team-col[data-side="${side}"]`);
    const s = state.match.sides[side];
    let el = $('.overall-history', col);
    if (!el) {
      el = document.createElement('ol');
      el.className = 'history overall-history';
      $('.overall', col).appendChild(el);
    }
    el.innerHTML = s.attempts.map((a) => {
      const isBest = s.best && a.no === s.best.no;
      return `<li class="${isBest ? 'is-best' : ''}" title="${a.reason}">#${a.no} ${a.checkpoints}CP ${fmtLap(a.scoreMs)}</li>`;
    }).join('');
  }
}

// ---------- clock tools & footer ----------

function updateClockTools() {
  const tools = $('#clock-tools');
  const c = state.clock;
  let html = '';
  if (state.match && !c.over) {
    html = c.since != null
      ? '<button type="button" class="abtn abtn-sm abtn-ghost" data-clock="pause" title="Freeze the match clock and both robots">Pause everything</button>'
      : `<button type="button" class="abtn abtn-sm abtn-primary" data-clock="start">${c.accum ? 'Resume clock' : 'Start clock'}</button>`;
  }
  if (tools.dataset.html !== html) { tools.innerHTML = html; tools.dataset.html = html; }
  const fresh = state.match && !c.accum && c.since == null && SIDES.every((s) => state.match.sides[s].watch.status === 'idle' && !state.match.sides[s].attempts.length);
  $('#edit-btn').hidden = !fresh;
  $('#restart-btn').hidden = !state.match;
  $('#next-btn').textContent = state.match ? 'Next match' : 'Set up match';
}

$('#clock-tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-clock]');
  if (b) act(`clock.${b.dataset.clock}`);
});

$('#restart-btn').addEventListener('click', () => {
  if (confirm('Restart this match?\n\nEvery attempt in it is discarded and the clock goes back to the start.')) act('match.restart');
});

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
  <details class="side-box" open>
    <summary>Add team</summary>
    <form class="form-row" id="add-form">
      <input class="field" name="name" placeholder="Team name" required maxlength="60">
      <input class="field" name="headstart" placeholder="Headstart" style="max-width:96px" maxlength="20">
      <button class="abtn abtn-sm abtn-primary" type="submit">Add</button>
    </form>
  </details>
  <details class="side-box">
    <summary>Bulk import</summary>
    <textarea class="field" id="bulk-text" placeholder="One per line: Team name, headstart"></textarea>
    <div class="form-row"><button class="abtn abtn-sm abtn-primary" type="button" id="bulk-btn">Import</button><span class="field-label">Existing names get their headstart updated.</span></div>
  </details>
  <details class="side-box">
    <summary>Results</summary>
    <ol class="results-list" id="results-list"></ol>
    <div class="form-row" style="margin-top:8px"><a class="abtn abtn-sm abtn-ghost" id="export-link" href="#">Download all attempts (CSV)</a></div>
  </details>
  <details class="side-box">
    <summary>Settings</summary>
    <form id="settings-form">
      <div class="form-row"><span class="field-label" style="flex:1">Match length (minutes)</span><input class="field" name="minutes" type="number" min="0.5" max="60" step="0.5" style="max-width:90px"></div>
      <div class="form-row"><span class="field-label" style="flex:1">Checkpoints drawn on the audience track</span><input class="field" name="cps" type="number" min="2" max="12" style="max-width:90px"></div>
      <div class="form-row"><button class="abtn abtn-sm abtn-primary" type="submit">Save settings</button><button class="linkish" type="button" id="forget-key">Lock this console</button></div>
    </form>
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
  act('settings.update', { matchDurationMs: Math.round(Number(f.minutes.value) * 60000), trackCheckpoints: Number(f.cps.value) })
    .then((ok) => ok && toast('Settings saved.'));
});

$('#forget-key').addEventListener('click', () => {
  try { localStorage.removeItem(KEY_STORE); } catch { /* fine */ }
  key = '';
  askKey();
});

$('#export-link').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = `/api/export.csv?key=${encodeURIComponent(key)}`;
});

let rosterKey = '';
let rosterPending = false;
const list = $('#roster-list');

function renderRoster() {
  const sides = state.match?.sides;
  const k = JSON.stringify([state.teams, sides?.A.teamId, sides?.B.teamId]);
  if (k === rosterKey) return;
  if (list.contains(document.activeElement)) { rosterPending = true; return; }
  rosterKey = k;
  rosterPending = false;
  if (!state.teams.length) {
    list.innerHTML = '<li class="roster-empty">No teams yet. Add them below.</li>';
    return;
  }
  list.innerHTML = state.teams.map((t, i) => {
    const cls = t.eliminated ? 'out' : sides?.A.teamId === t.id ? 'in-match-a' : sides?.B.teamId === t.id ? 'in-match-b' : '';
    return `<li class="team-row edit ${cls}" data-id="${t.id}">
      <span class="seed">${i + 1}</span>
      <input data-field="name" value="${esc(t.name)}" aria-label="Team name" maxlength="60">
      <input class="th" data-field="headstart" value="${esc(t.headstart)}" placeholder="—" aria-label="Headstart for ${esc(t.name)}" maxlength="20">
      <span class="row-tools">
        <button type="button" data-toggle title="${t.eliminated ? 'Bring back into the bracket' : 'Mark as out of the bracket'}">${t.eliminated ? 'IN' : 'OUT'}</button>
        <button type="button" data-del title="Delete team" aria-label="Delete ${esc(t.name)}">✕</button>
      </span>
    </li>`;
  }).join('');
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
  if (e.target.closest('[data-toggle]')) act('teams.update', { id, eliminated: !team.eliminated });
  if (e.target.closest('[data-del]') && confirm(`Delete ${team.name}?`)) act('teams.delete', { id });
});

function renderSideInfo() {
  const results = $('#results-list');
  results.innerHTML = state.results.length
    ? state.results.map((r) => `<li>${esc(ROUND_NAMES[r.round][0])}: ${esc(r.teamA)} vs ${esc(r.teamB)} → ${r.winner ? `<b>${esc(r.winner)}</b>` : 'no result'}</li>`).join('')
    : '<li>No finished matches yet.</li>';
  const f = $('#settings-form');
  if (!f.contains(document.activeElement)) {
    f.minutes.value = state.settings.matchDurationMs / 60000;
    f.cps.value = state.settings.trackCheckpoints;
  }
}

// ---------- next match / edit pairing dialog ----------

const better = (a, b) => {
  if (!a) return false;
  if (!b) return true;
  return a.checkpoints > b.checkpoints || (a.checkpoints === b.checkpoints && a.scoreMs < b.scoreMs);
};

let dlgMode = 'next';

function openNext(mode) {
  dlgMode = mode;
  const m = state.match;
  const editing = mode === 'edit';
  $('#next-title').textContent = editing ? 'Edit pairing' : m ? 'Next match' : 'Set up match';
  $('#winner-set').hidden = editing || !m;
  $('#no-next-row').hidden = editing || !m;
  $('#no-next').checked = false;
  $('#pairing-legend').textContent = editing ? 'Pairing' : 'Next pairing';
  $('#next-submit').textContent = editing ? 'Save' : m ? 'Finish & go' : 'Start match';
  $('#next-error').textContent = '';
  if (m && !editing) {
    const [a, b] = SIDES.map((s) => m.sides[s]);
    const suggest = better(a.best, b.best) ? 'A' : better(b.best, a.best) ? 'B' : '';
    const name = (s) => state.teams.find((t) => t.id === s.teamId)?.name ?? '?';
    const choice = (val, label, best, star) => `
      <label class="choice"><input type="radio" name="winner" value="${val}" ${val === suggest ? 'checked' : ''}>
        <span class="grow">${label}${star ? ' <span class="tm tm-live">suggested</span>' : ''}</span>
        <span class="mono">${best ? `${best.checkpoints} CP · ${fmtLap(best.scoreMs)}` : ''}</span></label>`;
    $('#winner-choices').innerHTML =
      choice('A', `${esc(name(a))} wins`, a.best, suggest === 'A') +
      choice('B', `${esc(name(b))} wins`, b.best, suggest === 'B') +
      choice('', 'No result (don\'t eliminate anyone)', null, false);
    if (!suggest) $('#winner-choices input[value=""]').checked = true;
  }
  const roundSel = $('#next-round');
  roundSel.value = String(m?.round ?? state.results[0]?.round ?? ROUNDS[0]);
  if (editing) {
    fillTeams(m.sides.A.teamId, m.sides.B.teamId);
  } else {
    suggestPairing(true);
  }
  $('#next-dlg').showModal();
}

/** Teams still in the bracket once the chosen result is applied. */
function activeTeams() {
  const m = state.match;
  let loser = null;
  if (m && dlgMode === 'next') {
    const w = $('#winner-choices input:checked')?.value;
    if (w) loser = m.sides[w === 'A' ? 'B' : 'A'].teamId;
  }
  return state.teams.filter((t) => !t.eliminated && t.id !== loser);
}

function suggestPairing(adjustRound) {
  const roundSel = $('#next-round');
  const active = activeTeams();
  let round = Number(roundSel.value);
  // When the bracket has shrunk to the next round's size, move on to it.
  if (adjustRound && state.match && active.length <= round / 2 && round > 2) round /= 2;
  roundSel.value = String(round);
  const played = new Set();
  for (const r of state.results) if (r.round === round) { played.add(nameToId(r.teamA)); played.add(nameToId(r.teamB)); }
  if (state.match?.round === round && dlgMode === 'next') { played.add(state.match.sides.A.teamId); played.add(state.match.sides.B.teamId); }
  const fresh = active.filter((t) => !played.has(t.id));
  const pool = fresh.length >= 2 ? fresh : active;
  fillTeams(pool[0]?.id, pool[1]?.id);
}

const nameToId = (name) => state.teams.find((t) => t.name === name)?.id;

function fillTeams(aId, bId) {
  const active = activeTeams();
  const ids = new Set(active.map((t) => t.id));
  const extra = state.teams.filter((t) => !ids.has(t.id) && (t.id === aId || t.id === bId));
  const opts = [...active, ...extra].map((t) => `<option value="${t.id}">${esc(t.name)}${t.headstart ? ` (${esc(t.headstart)})` : ''}${t.eliminated ? ' [out]' : ''}</option>`).join('');
  for (const [sel, id] of [['#next-a', aId], ['#next-b', bId]]) {
    $(sel).innerHTML = opts;
    if (id != null) $(sel).value = String(id);
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-next]')) {
    if (!state.teams.length) { toast('Add some teams first.', true); return; }
    openNext('next');
  }
});
$('#edit-btn').addEventListener('click', () => openNext('edit'));
$('#next-cancel').addEventListener('click', () => $('#next-dlg').close());
$('#winner-choices').addEventListener('change', () => suggestPairing(true));
$('#next-round').addEventListener('change', () => suggestPairing(false));
$('#no-next').addEventListener('change', (e) => { $('.dlg-grid', $('#pairing-set')).hidden = e.target.checked; });

$('#next-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pairing = { round: Number($('#next-round').value), teamA: Number($('#next-a').value), teamB: Number($('#next-b').value) };
  const noNext = $('#no-next').checked && !$('#no-next-row').hidden;
  if (!noNext && pairing.teamA === pairing.teamB) { $('#next-error').textContent = 'Pick two different teams.'; return; }
  let ok;
  if (dlgMode === 'edit') {
    ok = await act('match.edit', pairing);
  } else {
    const winner = $('#winner-choices input:checked')?.value || null;
    ok = await act('match.next', { winner, next: noNext ? null : pairing });
  }
  if (ok) {
    $('.dlg-grid', $('#pairing-set')).hidden = false;
    $('#next-dlg').close();
  }
});

// ---------- main loop ----------

function render(next) {
  state = next;
  renderRoster();
  renderSideInfo();
  updateHeader(state);
  $('#versus').hidden = !state.match;
  $('#splash').hidden = !!state.match;
  updateTeams(state);
  updateControls();
  updateHistory();
  updateClockTools();
}

function loop() {
  if (state) {
    frameHeader(state);
    frameTeams(state);
  }
  requestAnimationFrame(loop);
}

live = connect(render, (ok) => { $('#conn').hidden = ok; });
requestAnimationFrame(loop);
if (!key) askKey(); else act('ping');
