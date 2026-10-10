// Board layout shared by the audience display and the admin console.
import {
  capT, clockRemaining, esc, fmtCountdown, fmtHead, fmtLap, fmtSigned, lapElapsed, roundName, serverNow, sum, teamById,
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

/** Which body the board shows: the live match, the bracket tree, or the pre-tournament setup. */
export function viewOf(state) {
  const t = state.tournament;
  if (t.size == null) return 'setup';
  if (t.view === 'match' && state.match) return 'match';
  return 'bracket';
}

export function rosterHTML({ collapsible }) {
  return `
    <aside class="roster panel" aria-label="Teams">
      <div class="roster-head">
        <div class="cbox-wrap"><div class="cbox cbox-gold"><h2>TEAMS</h2></div></div>
        ${collapsible ? '<button class="collapse-btn" id="collapse" type="button" aria-label="Collapse team list" title="Collapse team list">«</button>' : ''}
      </div>
      <span class="roster-vertical" aria-hidden="true">TEAMS</span>
      <div class="roster-cols"><span class="tm">Seed · team</span><span class="tm">Headstart</span></div>
      <ol class="roster-list" id="roster-list"></ol>
      <div id="roster-extra"></div>
    </aside>`;
}

export function teamColHTML(side, middle) {
  return `
    <div class="team-col" data-side="${side}">
      <div class="team-name cbox-wrap"><div class="cbox"><h2><span class="side-tag">${side}</span><span data-name>—</span></h2><span class="hs-chip" data-hs></span></div></div>
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
        <div class="overall-row"><span class="k">Best score <small>time − headstart</small></span><span class="v" data-best>—</span></div>
      </div></div>
    </div>`;
}

export function headerHTML(tools = '') {
  return `
    <header class="scoreboard-head">
      <div class="round-title cbox-wrap"><div class="cbox cbox-gold"><h1 id="round-name">ZipIt Finals</h1><span class="round-sub" id="round-sub">Line follower showdown</span></div></div>
      <div class="countdown panel" id="countdown">
        <div class="countdown-label" id="countdown-label"><span class="tm tm-dim">Match clock</span></div>
        <div class="countdown-digits" id="countdown-digits" role="timer" aria-live="off">10:00</div>
        <div class="countdown-bar"><i id="countdown-bar"></i></div>
      </div>
      ${tools}
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

export function rosterRowClass(state, t) {
  const sides = state.match?.sides;
  if (t.eliminated || t.unseeded) return 'out';
  if (sides?.A.teamId === t.id) return 'in-match-a';
  if (sides?.B.teamId === t.id) return 'in-match-b';
  return '';
}

export function outTag(t) {
  if (t.unseeded) return '<span class="out-tag">NOT IN BRACKET</span>';
  if (t.eliminated) return `<span class="out-tag">OUT · ${esc(roundName(t.eliminatedRound)[0])}</span>`;
  return '';
}

export function renderRosterReadOnly(list, state) {
  if (!state.teams.length) {
    list.innerHTML = '<li class="roster-empty">No teams yet.</li>';
    return;
  }
  list.innerHTML = state.teams.map((t) => `
    <li class="team-row ${rosterRowClass(state, t)}"><span class="seed">${t.seed}</span><span class="tname" title="${esc(t.name)}">${esc(t.name)}</span><span class="thead">${fmtHead(t.headstart)}</span>${outTag(t)}</li>`).join('');
}

// ---------- header ----------

export function updateHeader(state) {
  const view = viewOf(state);
  const t = state.tournament;
  let title = ['ZipIt Finals', 'Line follower showdown'];
  if (view === 'match') {
    title = [roundName(state.match.round)[0], `${roundName(state.match.round)[1]} · Match ${state.match.matchNo} of ${state.match.matchCount}`];
  } else if (view === 'bracket') {
    const champ = t.champion != null;
    title = champ ? ['Champions', 'ZipIt Finals'] : [roundName(t.round)[0], t.roundOver ? 'Round complete' : t.roundStarted ? 'Bracket' : 'Up next'];
  }
  document.getElementById('round-name').textContent = title[0];
  document.getElementById('round-sub').textContent = title[1];
  document.getElementById('countdown').hidden = view !== 'match';
  document.body.dataset.view = view;
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
  if (!state.match) return;
  const el = document.getElementById('countdown');
  const remaining = clockRemaining(state.clock);
  document.getElementById('countdown-digits').textContent = fmtCountdown(remaining);
  document.getElementById('countdown-bar').style.transform = `scaleX(${remaining / state.clock.durationMs})`;
  const phase = clockPhase(state);
  el.classList.toggle('is-low', phase === 'live' && remaining < 60000);
  el.classList.toggle('is-final', phase === 'live' && remaining < 10000);
  el.classList.toggle('is-over', phase === 'over');
  if (phase !== lastPhase) {
    lastPhase = phase;
    document.getElementById('countdown-label').innerHTML = {
      ready: `<span class="tm">Match clock · ${fmtCountdown(state.clock.durationMs)}</span>`,
      live: '<span class="tm tm-live"><i class="dot dot-pulse"></i>Live</span>',
      paused: '<span class="tm tm-warn">Clock paused</span>',
      over: '<span class="tm tm-red">Time!</span>',
    }[phase];
  }
}

// ---------- team columns ----------

const STATUS = {
  idle: ['Ready', 'tm-dim'],
  running: ['<i class="dot dot-pulse"></i>Running', 'tm-live'],
  paused: ['Paused', 'tm-warn'],
  complete: ['Finished run', 'tm-live'],
  done: ['Time up', 'tm-red'],
};

const lapKeys = {};

/** Big score with its working: "01:00.30" over "6/6 CP · 01:12.30 − 12s". */
export function scoreHTML(best, checkpoints, headstart) {
  if (!best) return '—';
  return `${fmtSigned(best.scoreMs)} <small>${best.checkpoints}/${checkpoints} CP · ${fmtLap(best.timeMs)} − ${fmtHead(headstart)}</small>`;
}

export function updateTeams(state, { editable = false } = {}) {
  if (!state.match) return;
  const n = state.match.checkpoints;
  for (const side of SIDES) {
    const col = document.querySelector(`.team-col[data-side="${side}"]`);
    const s = state.match.sides[side];
    const w = s.watch;
    const team = teamById(state, s.teamId);
    col.querySelector('[data-name]').textContent = team?.name ?? '—';
    col.querySelector('[data-hs]').textContent = `Headstart ${fmtHead(team?.headstart ?? 0)}`;
    col.querySelector('[data-attempt]').textContent = `Attempt ${w.attemptNo}`;
    col.querySelector('[data-cps]').textContent = `${w.laps.length}/${n} CP`;
    const [label, cls] = STATUS[w.status];
    const st = col.querySelector('[data-status]');
    st.className = `tm ${cls}`;
    st.innerHTML = label;
    col.querySelector('[data-lap-label]').textContent = {
      idle: state.clock.over ? 'Time is up' : 'Ready to start',
      running: `Checkpoint ${w.laps.length + 1} of ${n} · current lap`,
      paused: `Checkpoint ${w.laps.length + 1} of ${n} · paused`,
      complete: `All ${n} checkpoints · run complete`,
      done: 'Time is up · attempt saved',
    }[w.status];
    const digits = col.querySelector('[data-lap]');
    digits.classList.toggle('running', w.status === 'running');
    digits.classList.toggle('paused', w.status === 'paused');
    digits.classList.toggle('complete', w.status === 'complete');
    col.querySelector('[data-attempt-no]').textContent = String(w.status === 'done' ? s.attempts.length : w.attemptNo);
    col.querySelector('[data-best]').innerHTML = scoreHTML(s.best, n, team?.headstart ?? 0);
    renderLaps(col.querySelector('[data-laps]'), side, state.match.id, w, editable);
  }
}

function renderLaps(list, side, matchId, w, editable) {
  const attempt = `${matchId}:${w.attemptNo}`;
  const key = `${attempt}:${w.laps.join(',')}:${editable && w.status}`;
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
  const canEdit = editable && ['running', 'paused', 'complete'].includes(w.status);
  let cum = 0;
  const rows = w.laps.map((ms, i) => {
    cum += ms;
    const mark = w.laps.length >= 3 ? (ms === min ? 'best' : ms === max ? 'worst' : '') : '';
    const attrs = canEdit ? ` data-edit-live="${side}" tabindex="0" role="button" title="Click to edit the splits"` : '';
    return `<li class="${mark}${canEdit ? ' editable' : ''}"${attrs}><span class="cp">CP ${i + 1}</span><span class="cum">${fmtLap(cum)}</span><span class="split">${fmtLap(ms)}</span></li>`;
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
    const lap = w.status === 'complete' ? sum(w.laps) : lapElapsed(w, t);
    col.querySelector('[data-lap]').textContent = fmtLap(lap);
    col.querySelector('[data-total]').textContent = fmtLap(sum(w.laps) + (w.status === 'complete' ? 0 : lap));
  }
}
