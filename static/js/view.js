// Board layout shared by the audience display and the admin console.
import {
  ROUND_NAMES, capT, clockElapsed, clockRemaining, esc, fmtCountdown, fmtLap, fmtScore, lapElapsed, serverNow, sum, teamById,
} from './core.js';

export const SIDES = ['A', 'B'];

const BURST = (() => {
  const pts = [];
  const n = 14;
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? 30 + ((i * 37) % 9) : 50;
    const a = (Math.PI * i) / n;
    pts.push(`${(50 + Math.cos(a) * r).toFixed(1)},${(50 + Math.sin(a) * r * 0.82).toFixed(1)}`);
  }
  return pts.join(' ');
})();

export function burstSVG(fill = 'var(--zi-red)') {
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="${BURST}" fill="${fill}" stroke="var(--zi-ink)" stroke-width="3" stroke-linejoin="round"/></svg>`;
}

export function rosterHTML({ collapsible }) {
  return `
    <aside class="roster panel" aria-label="Teams">
      <div class="roster-head">
        <div class="cbox-wrap"><div class="cbox cbox-gold"><h2>TEAMS</h2></div></div>
        ${collapsible ? '<button class="collapse-btn" id="collapse" type="button" aria-label="Collapse team list" title="Collapse team list">«</button>' : ''}
      </div>
      <span class="roster-vertical" aria-hidden="true">TEAMS</span>
      <div class="roster-cols"><span class="tm">Team name</span><span class="tm">Headstart</span></div>
      <ol class="roster-list" id="roster-list"></ol>
      <div id="roster-extra"></div>
    </aside>`;
}

export function teamColHTML(side, middle) {
  return `
    <div class="team-col" data-side="${side}">
      <div class="team-name cbox-wrap"><div class="cbox"><h2><span class="side-tag">${side}</span><span data-name>—</span></h2></div></div>
      <div class="attempt panel">
        <div class="attempt-top">
          <span class="tm" data-attempt>Attempt 1</span>
          <span class="tm" data-cps>0 CP</span>
          <span class="grow"></span>
          <span class="tm" data-status>Ready</span>
        </div>
        <div class="lap-now">
          <div class="lap-now-label" data-lap-label>Ready to start</div>
          <div class="lap-now-digits" data-lap>00:00.00</div>
          <div class="lap-now-total">Attempt time <b data-total>00:00.00</b></div>
        </div>
        <ol class="laps" data-laps aria-label="Checkpoint splits"></ol>
      </div>
      ${middle}
      <div class="cbox-wrap"><div class="cbox overall">
        <div class="overall-title">Overall</div>
        <div class="overall-row"><span class="k">Attempt number</span><span class="v" data-attempt-no>1</span></div>
        <div class="overall-row"><span class="k">Best attempt</span><span class="v" data-best>—</span></div>
      </div></div>
    </div>`;
}

export function headerHTML(extra = '') {
  return `
    <header class="scoreboard-head">
      <div class="round-title cbox-wrap"><div class="cbox cbox-gold"><h1 id="round-name">ZipIt Finals</h1><span class="round-sub" id="round-sub">Line follower showdown</span></div></div>
      <div class="countdown panel" id="countdown">
        <div class="countdown-label" id="countdown-label"><span class="tm tm-dim">Match clock</span></div>
        <div class="countdown-digits" id="countdown-digits" role="timer" aria-live="off">10:00</div>
        <div class="countdown-bar"><i id="countdown-bar"></i></div>
      </div>
      ${extra}
    </header>`;
}

export function versusHTML(middleA, middleB) {
  return `
    <section class="versus" id="versus">
      ${teamColHTML('A', middleA)}
      <div class="vs-badge" aria-hidden="true">${burstSVG()}<span>VS</span></div>
      ${teamColHTML('B', middleB)}
    </section>`;
}

// ---------- roster ----------

export function renderRosterReadOnly(list, state) {
  const sides = state.match?.sides;
  if (!state.teams.length) {
    list.innerHTML = '<li class="roster-empty">No teams yet.</li>';
    return;
  }
  list.innerHTML = state.teams.map((t, i) => {
    const cls = t.eliminated ? 'out' : sides?.A.teamId === t.id ? 'in-match-a' : sides?.B.teamId === t.id ? 'in-match-b' : '';
    const outTag = t.eliminated ? `<span class="out-tag">OUT${t.eliminatedRound ? ` · R${t.eliminatedRound}` : ''}</span>` : '';
    return `<li class="team-row ${cls}"><span class="seed">${i + 1}</span><span class="tname" title="${esc(t.name)}">${esc(t.name)}</span><span class="thead">${esc(t.headstart || '—')}</span>${outTag}</li>`;
  }).join('');
}

// ---------- header ----------

export function updateHeader(state) {
  const [name, sub] = ROUND_NAMES[state.match?.round] ?? ['ZipIt Finals', 'Line follower showdown'];
  document.getElementById('round-name').textContent = name;
  document.getElementById('round-sub').textContent = sub;
  document.getElementById('countdown').hidden = !state.match;
}

function clockPhase(state) {
  const c = state.clock;
  if (c.over) return 'over';
  if (c.since != null) return 'live';
  if (c.accum > 0) return 'paused';
  return 'ready';
}

let lastPhase = '';
export function frameHeader(state) {
  const el = document.getElementById('countdown');
  const remaining = state.match ? clockRemaining(state.clock) : state.clock.durationMs;
  document.getElementById('countdown-digits').textContent = fmtCountdown(remaining);
  document.getElementById('countdown-bar').style.transform = `scaleX(${remaining / state.clock.durationMs})`;
  const phase = state.match ? clockPhase(state) : 'idle';
  el.classList.toggle('is-low', phase === 'live' && remaining < 60000);
  el.classList.toggle('is-final', phase === 'live' && remaining < 10000);
  el.classList.toggle('is-over', phase === 'over');
  if (phase !== lastPhase) {
    lastPhase = phase;
    const label = {
      idle: '<span class="tm tm-dim">Waiting for match</span>',
      ready: `<span class="tm">Match clock · ${fmtCountdown(state.clock.durationMs)}</span>`,
      live: '<span class="tm tm-live"><i class="dot dot-pulse"></i>Live</span>',
      paused: '<span class="tm tm-warn">Clock paused</span>',
      over: '<span class="tm tm-red">Time!</span>',
    }[phase];
    document.getElementById('countdown-label').innerHTML = label;
  }
}

// ---------- team columns ----------

const STATUS = {
  idle: ['Ready', 'tm-dim'],
  running: ['<i class="dot dot-pulse"></i>Running', 'tm-live'],
  paused: ['Paused', 'tm-warn'],
  done: ['Finished', 'tm-red'],
};

const lapKeys = {};

export function updateTeams(state) {
  if (!state.match) return;
  for (const side of SIDES) {
    const col = document.querySelector(`.team-col[data-side="${side}"]`);
    const s = state.match.sides[side];
    const w = s.watch;
    const team = teamById(state, s.teamId);
    col.querySelector('[data-name]').textContent = team?.name ?? '—';
    col.querySelector('[data-attempt]').textContent = `Attempt ${w.attemptNo}`;
    col.querySelector('[data-cps]').textContent = `${w.laps.length} CP`;
    const [label, cls] = STATUS[w.status];
    const st = col.querySelector('[data-status]');
    st.className = `tm ${cls}`;
    st.innerHTML = label;
    col.querySelector('[data-lap-label]').textContent = {
      idle: state.clock.over ? 'Time is up' : 'Ready to start',
      running: `Checkpoint ${w.laps.length + 1} · current lap`,
      paused: `Checkpoint ${w.laps.length + 1} · paused`,
      done: 'Time is up · attempt saved',
    }[w.status];
    const digits = col.querySelector('[data-lap]');
    digits.classList.toggle('running', w.status === 'running');
    digits.classList.toggle('paused', w.status === 'paused');
    col.querySelector('[data-attempt-no]').textContent = String(w.status === 'done' ? s.attempts.length : w.attemptNo);
    const best = col.querySelector('[data-best]');
    best.innerHTML = s.best ? `${s.best.checkpoints} CP <small>· ${fmtLap(s.best.scoreMs)}</small>` : '—';
    best.title = fmtScore(s.best);
    renderLaps(col.querySelector('[data-laps]'), side, state.match.id, w);
  }
}

function renderLaps(list, side, matchId, w) {
  const attempt = `${matchId}:${w.attemptNo}`;
  const key = `${attempt}:${w.laps.join(',')}`;
  const prev = lapKeys[side];
  if (prev?.key === key) return;
  lapKeys[side] = { key, attempt, count: w.laps.length };
  const grew = prev?.attempt === attempt && prev.count < w.laps.length;
  if (!w.laps.length) {
    list.innerHTML = '<li class="laps-empty">Checkpoint splits show up here</li>';
    return;
  }
  const min = Math.min(...w.laps);
  const max = Math.max(...w.laps);
  let cum = 0;
  const rows = w.laps.map((ms, i) => {
    cum += ms;
    const mark = w.laps.length >= 3 ? (ms === min ? 'best' : ms === max ? 'worst' : '') : '';
    return `<li class="${mark}"><span class="cp">CP ${i + 1}</span><span class="cum">${fmtLap(cum)}</span><span class="split">${fmtLap(ms)}</span></li>`;
  });
  rows.reverse();
  if (grew) rows[0] = rows[0].replace('<li class="', '<li class="new ');
  list.innerHTML = rows.join('');
  list.scrollTop = 0;
}

/** Per-animation-frame update of the running numbers. */
export function frameTeams(state) {
  if (!state.match) return;
  const t = capT(state, serverNow());
  for (const side of SIDES) {
    const col = document.querySelector(`.team-col[data-side="${side}"]`);
    const w = state.match.sides[side].watch;
    const lap = lapElapsed(w, t);
    col.querySelector('[data-lap]').textContent = fmtLap(lap);
    col.querySelector('[data-total]').textContent = fmtLap(sum(w.laps) + lap);
  }
}

export { clockElapsed };
