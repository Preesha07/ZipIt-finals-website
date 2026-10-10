// Audience display: read-only, projector friendly.
import { connect, esc, tickIfDue } from './core.js';
import {
  SIDES, frameHeader, frameTeams, headerHTML, renderRosterReadOnly, rosterHTML, updateHeader, updateTeams, versusHTML, viewOf,
} from './view.js';
import { mountBracket } from './bracket.js';
import { Track } from './track.js';

const trackSlot = (side) => `<div class="panel track-panel" data-track="${side}"></div>`;

document.getElementById('app').innerHTML = `
  <div class="stage">
    ${rosterHTML({ collapsible: false })}
    <main class="arena">
      ${headerHTML('<span class="tm cp-chip" id="cp-chip" hidden></span>')}
      <div class="body-slot">
        ${versusHTML(trackSlot('A'), trackSlot('B'))}
        <section class="panel bracket-panel" id="bracket" hidden>
          <div class="champ-banner" id="champ-banner" hidden></div>
          <div class="bracket-wrap" id="bracket-wrap"></div>
        </section>
        <section class="panel splash" id="splash" hidden>
          <h2>Bracket<br>coming up</h2>
          <p>Seeds are being locked in. Bots to the pit lane.</p>
        </section>
      </div>
    </main>
  </div>`;

const bracket = mountBracket(document.getElementById('bracket-wrap'));
const tracks = Object.fromEntries(SIDES.map((s) => [s, new Track(document.querySelector(`[data-track="${s}"]`), s)]));
let state = null;
let confettiFor = null;

function render(next) {
  state = next;
  const view = viewOf(state);
  renderRosterReadOnly(document.getElementById('roster-list'), state);
  updateHeader(state);
  document.getElementById('versus').hidden = view !== 'match';
  document.getElementById('bracket').hidden = view !== 'bracket';
  document.getElementById('splash').hidden = view !== 'setup';
  const chip = document.getElementById('cp-chip');
  chip.hidden = view !== 'match';
  if (state.match) chip.textContent = `${state.match.checkpoints} checkpoints`;
  if (view === 'match') updateTeams(state);
  if (view === 'bracket') renderBracket();
  else bracket.reset();
  // Tracks measure their SVG path, so only touch them while they're on screen.
  if (view === 'match') for (const t of Object.values(tracks)) t.update(state);
}

function renderBracket() {
  const champ = state.tournament.champion;
  const banner = document.getElementById('champ-banner');
  banner.hidden = champ == null;
  if (champ != null) {
    const team = state.teams.find((t) => t.id === champ);
    banner.innerHTML = `<span class="champ-word">Champion!</span><span class="cbox-wrap"><span class="cbox cbox-gold champ-name">${esc(team?.name)}</span></span>`;
    if (confettiFor !== champ) { confettiFor = champ; confetti(); }
  }
  bracket.update(state); // after the banner, so it measures the space that's left
}

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#FFC83D', '#E01E37', '#FFF6E8', '#7CFFB2'];
  for (let i = 0; i < 140; i++) {
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
  if (state && viewOf(state) === 'match') {
    frameHeader(state);
    frameTeams(state);
    tickIfDue(state);
    for (const t of Object.values(tracks)) t.frame(now);
  }
  requestAnimationFrame(loop);
}

connect(render, (ok) => { document.getElementById('conn').hidden = ok; });
requestAnimationFrame(loop);
