// Audience display: read-only, projector friendly.
import { connect, esc, ROUND_NAMES } from './core.js';
import {
  SIDES, burstSVG, frameHeader, frameTeams, headerHTML, renderRosterReadOnly, rosterHTML, updateHeader, updateTeams, versusHTML,
} from './view.js';
import { Track } from './track.js';

const trackSlot = (side) => `<div class="panel track-panel" data-track="${side}"></div>`;

document.getElementById('app').innerHTML = `
  <div class="stage">
    ${rosterHTML({ collapsible: false })}
    <main class="arena">
      ${headerHTML()}
      ${versusHTML(trackSlot('A'), trackSlot('B'))}
      <section class="panel splash" id="splash" hidden></section>
    </main>
  </div>`;

const tracks = Object.fromEntries(SIDES.map((s) => [s, new Track(document.querySelector(`[data-track="${s}"]`), s)]));
const versus = document.getElementById('versus');
const splash = document.getElementById('splash');
let state = null;
let splashKey = '';

function render(next) {
  state = next;
  renderRosterReadOnly(document.getElementById('roster-list'), state);
  updateHeader(state);
  versus.hidden = !state.match;
  splash.hidden = !!state.match;
  if (state.match) {
    updateTeams(state);
  } else {
    renderSplash();
  }
  for (const t of Object.values(tracks)) t.update(state);
}

function renderSplash() {
  const last = state.results[0];
  const champion = last && last.round === 2 && last.winner;
  const key = champion ? `champ:${last.id}` : `wait:${last?.id ?? 0}`;
  if (key === splashKey) return;
  splashKey = key;
  if (champion) {
    splash.innerHTML = `
      <div class="trophy" aria-hidden="true">🏆</div>
      <h2>Champion!</h2>
      <div class="cbox-wrap"><div class="cbox cbox-gold champion-name">${esc(last.winner)}</div></div>
      <p>Winner of the ZipIt line follower final against ${esc(last.winner === last.teamA ? last.teamB : last.teamA)}</p>`;
    confetti();
    return;
  }
  const recent = state.results.slice(0, 4).filter((r) => r.winner).map((r) =>
    `<span class="chip">${esc(ROUND_NAMES[r.round][0])} · <b style="color:var(--zi-gold)">${esc(r.winner)}</b> beat ${esc(r.winner === r.teamA ? r.teamB : r.teamA)}</span>`).join('');
  splash.innerHTML = `
    <div class="vs-badge" style="width:120px" aria-hidden="true">${burstSVG()}<span>!</span></div>
    <h2>Next match<br>coming up</h2>
    <p>Bots to the start line. The clock starts with the first run.</p>
    ${recent ? `<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">${recent}</div>` : ''}`;
}

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#FFC83D', '#E01E37', '#FFF6E8', '#7CFFB2'];
  for (let i = 0; i < 120; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}vw`;
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = `${2.5 + Math.random() * 3}s`;
    p.style.animationDelay = `${Math.random() * 2}s`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 8000);
}

function loop(now) {
  if (state) {
    frameHeader(state);
    frameTeams(state);
    for (const t of Object.values(tracks)) t.frame(now);
  }
  requestAnimationFrame(loop);
}

connect(render, (ok) => { document.getElementById('conn').hidden = ok; });
requestAnimationFrame(loop);
