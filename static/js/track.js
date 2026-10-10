// Mario Kart-style mini track for the audience display. One per team.
// The kart sits at the last checkpoint reached and creeps toward the next one
// while the robot is running; a checkpoint press makes it zoom ahead.
import { capT, esc, fmtLap, lapElapsed, serverNow } from './core.js';
import { burstSVG } from './view.js';

const NS = 'http://www.w3.org/2000/svg';
const TRACK_D = 'M 160 52 L 400 52 C 470 52 482 96 520 104 C 556 112 566 150 552 190 C 538 232 500 250 450 250 L 300 250 C 262 250 252 214 220 214 C 190 214 182 250 140 250 C 80 250 44 214 44 160 L 44 130 C 44 80 90 52 160 52 Z';
const CENTER = { x: 300, y: 150 };
const CP_WORDS = ['ZIP!', 'ZOOM!', 'VROOM!', 'WHOOSH!', 'NITRO!', 'ZAP!'];

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function kartSVG(color) {
  return `
    <g class="kart-body">
      <ellipse cx="0" cy="0" rx="22" ry="15" fill="rgba(0,0,0,.35)" transform="translate(3 4)"/>
      <rect x="-15" y="-15" width="10" height="6" rx="2" fill="#0c0204"/>
      <rect x="-15" y="9" width="10" height="6" rx="2" fill="#0c0204"/>
      <rect x="7" y="-13" width="8" height="5" rx="2" fill="#0c0204"/>
      <rect x="7" y="8" width="8" height="5" rx="2" fill="#0c0204"/>
      <rect x="-22" y="-11" width="5" height="22" rx="1.5" fill="#1C0509"/>
      <path d="M -17 -9 L 9 -8 Q 21 -6 21 0 Q 21 6 9 8 L -17 9 Q -20 0 -17 -9 Z" fill="${color}" stroke="#1C0509" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M 6 -4 L 16 -2 L 16 2 L 6 4 Z" fill="rgba(255,246,232,.55)"/>
      <circle cx="-4" cy="0" r="6" fill="#FFF6E8" stroke="#1C0509" stroke-width="2"/>
      <path d="M -1 -4.5 A 6 6 0 0 1 -1 4.5 Z" fill="#1C0509"/>
    </g>`;
}

export class Track {
  constructor(host, side) {
    this.side = side;
    this.color = side === 'A' ? '#E01E37' : '#FFC83D';
    this.n = 6;
    this.prev = null;
    this.matchId = null;
    this.d = 0;              // displayed distance (path units, unbounded)
    this.spinUntil = 0;
    this.lastPuff = 0;
    this.lastFrame = performance.now();
    this.wordIdx = side === 'A' ? 0 : 3;

    host.innerHTML = `
      <div class="track-wrap">
        <div class="track-hud"><span class="tm" data-loop>Lap 1</span><span class="tm" data-next>Next CP 1</span></div>
        <div class="track-lights" data-lights hidden><i></i><i></i><i></i></div>
        <div class="fx" data-fx></div>
      </div>`;
    this.wrap = host.querySelector('.track-wrap');
    this.fx = host.querySelector('[data-fx]');
    this.lights = host.querySelector('[data-lights]');
    this.hudLoop = host.querySelector('[data-loop]');
    this.hudNext = host.querySelector('[data-next]');

    const svg = svgEl('svg', { class: 'track', viewBox: '0 0 600 300', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
    svg.innerHTML = `
      <text x="300" y="166" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-weight="700" font-size="56"
        fill="none" stroke="rgba(255,200,61,.16)" stroke-width="2" letter-spacing="6">ZIPIT GP</text>
      <path d="${TRACK_D}" fill="none" stroke="#1C0509" stroke-width="54" stroke-linejoin="round"/>
      <path d="${TRACK_D}" fill="none" stroke="#FFF6E8" stroke-width="46" stroke-linejoin="round"/>
      <path d="${TRACK_D}" fill="none" stroke="#C8102E" stroke-width="46" stroke-dasharray="12 12" stroke-linejoin="round"/>
      <path d="${TRACK_D}" fill="none" stroke="#24070c" stroke-width="36" stroke-linejoin="round"/>
      <path d="${TRACK_D}" fill="none" stroke="#FFC83D" stroke-opacity=".7" stroke-width="2" stroke-dasharray="10 12"/>
      <g data-gates></g>
      <g data-items></g>
      <g data-puffs></g>
      <g data-kart>${kartSVG(this.color)}</g>`;
    this.wrap.prepend(svg);
    this.svg = svg;
    this.path = svgEl('path', { d: TRACK_D });
    svg.appendChild(this.path);
    this.path.setAttribute('visibility', 'hidden');
    this.L = this.path.getTotalLength();
    this.kart = svg.querySelector('[data-kart]');
    this.kartBody = svg.querySelector('.kart-body');
    this.puffs = svg.querySelector('[data-puffs]');
    this.drawGates();
    this.drawItems();
  }

  at(len) {
    const L = this.L;
    const s = ((len % L) + L) % L;
    const p = this.path.getPointAtLength(s);
    const q = this.path.getPointAtLength((s + 1) % L);
    return { x: p.x, y: p.y, angle: Math.atan2(q.y - p.y, q.x - p.x) };
  }

  drawGates() {
    const g = this.svg.querySelector('[data-gates]');
    g.innerHTML = '';
    this.gates = [];
    for (let k = 0; k < this.n; k++) {
      const { x, y, angle } = this.at((this.L * k) / this.n);
      const deg = (angle * 180) / Math.PI;
      if (k === 0) {
        // chequered start/finish line
        const flag = svgEl('g', { transform: `translate(${x} ${y}) rotate(${deg})` });
        let cells = '';
        for (let i = 0; i < 2; i++) for (let j = 0; j < 6; j++) {
          cells += `<rect x="${-6 + i * 6}" y="${-18 + j * 6}" width="6" height="6" fill="${(i + j) % 2 ? '#1C0509' : '#FFF6E8'}"/>`;
        }
        flag.innerHTML = cells;
        g.appendChild(flag);
      } else {
        g.appendChild(svgEl('line', {
          x1: -18, y1: 0, x2: 18, y2: 0, stroke: '#FFC83D', 'stroke-width': 3, 'stroke-dasharray': '4 3',
          transform: `translate(${x} ${y}) rotate(${deg + 90})`,
        }));
      }
      // badge sits outside the track, pushed away from the infield
      let nx = -Math.sin(angle), ny = Math.cos(angle);
      if (nx * (x - CENTER.x) + ny * (y - CENTER.y) < 0) { nx = -nx; ny = -ny; }
      const bx = x + nx * 40, by = y + ny * 40;
      const badge = svgEl('g', { transform: `translate(${bx} ${by})` });
      const label = k === 0 ? this.n : k;
      badge.innerHTML = `
        <g class="cp-badge">
          <circle r="13" fill="#FFF6E8" stroke="#1C0509" stroke-width="3"/>
          <text y="5" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-weight="700" font-size="14" fill="#1C0509">${k === 0 ? '🏁' : label}</text>
        </g>`;
      g.appendChild(badge);
      this.gates.push(badge.querySelector('.cp-badge'));
    }
    // gates[k] is checkpoint k (k=0 is the finish line, reached as checkpoint n)
  }

  drawItems() {
    const g = this.svg.querySelector('[data-items]');
    g.innerHTML = '';
    for (let k = 0; k < this.n; k++) {
      const { x, y } = this.at((this.L * (k + 0.5)) / this.n);
      const box = svgEl('g', { transform: `translate(${x} ${y})` });
      box.innerHTML = `<g class="item-box" style="animation-delay:${-k * 0.4}s">
        <rect x="-8" y="-8" width="16" height="16" rx="3" fill="rgba(255,200,61,.85)" stroke="#1C0509" stroke-width="2"/>
        <text y="5" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-weight="700" font-size="13" fill="#1C0509">?</text></g>`;
      g.appendChild(box);
    }
  }

  /** New snapshot for this side. Detects events and fires effects. */
  update(state) {
    const m = state.match;
    const n = state.settings.trackCheckpoints;
    if (n !== this.n) { this.n = n; this.drawGates(); this.drawItems(); }
    if (!m) { this.prev = null; return; }
    const w = m.sides[this.side].watch;
    this.state = state;
    this.w = w;
    const prev = this.matchId === m.id ? this.prev : null;
    if (this.matchId !== m.id) { this.matchId = m.id; this.d = 0; this.clearFx(); }

    if (prev) {
      if (w.attemptNo !== prev.attemptNo || (w.status === 'idle' && prev.status !== 'idle')) {
        this.sfx('KAPOW!', 'New attempt', 'slam', 'var(--zi-red)');
        this.spinUntil = performance.now() + 900;
        this.kartBody.classList.remove('kart-shake');
        void this.kartBody.getBoundingClientRect();
        this.kartBody.classList.add('kart-shake');
        setTimeout(() => { this.d = 0; }, 450);
      } else if (w.laps.length > prev.laps.length) {
        const k = w.laps.length;
        const split = w.laps[k - 1];
        const isBest = k > 1 && split <= Math.min(...w.laps.slice(0, -1));
        const word = k % this.n === 0 ? 'LAP!' : CP_WORDS[this.wordIdx++ % CP_WORDS.length];
        this.sfx(word, `CP ${k} · ${fmtLap(split)}${isBest ? ' ★' : ''}`, 'slam');
        const gate = this.gates[k % this.n];
        gate.classList.remove('cp-reached');
        void gate.getBoundingClientRect();
        gate.classList.add('cp-reached');
      } else if (w.status === 'running' && prev.status === 'idle') {
        this.sfx('GO!', null, 'slam', 'var(--zi-success)');
      } else if (w.status === 'paused' && prev.status === 'running') {
        this.sfx('PIT STOP', 'Paused', 'stay', 'var(--zi-warning)');
      } else if (w.status === 'running' && prev.status === 'paused') {
        this.clearFx();
        this.sfx('BACK ON!', null, 'slam', 'var(--zi-success)');
      }
      if (w.status === 'done' && prev.status !== 'done') {
        this.clearFx();
        this.sfx('TIME!', `${w.laps.length} CP`, 'stay');
      }
    } else if (w.status === 'paused') {
      this.sfx('PIT STOP', 'Paused', 'stay', 'var(--zi-warning)');
    } else if (w.status === 'done') {
      this.sfx('TIME!', `${w.laps.length} CP`, 'stay');
    }
    this.prev = { attemptNo: w.attemptNo, status: w.status, laps: [...w.laps] };

    this.lights.hidden = !(w.status === 'idle' && !state.clock.over);
    const k = w.laps.length;
    this.hudLoop.textContent = `Lap ${Math.floor(k / this.n) + 1}`;
    this.hudNext.textContent = w.status === 'done' ? `${k} CP total` : `Next CP ${k + 1}`;
    const r = k % this.n; // checkpoints reached on the current lap of the track
    this.gates.forEach((g, i) => {
      const reached = k > 0 && (r === 0 || (i >= 1 && i <= r));
      g.querySelector('circle').setAttribute('fill', reached ? '#FFC83D' : '#FFF6E8');
    });
  }

  clearFx() { this.fx.innerHTML = ''; }

  sfx(word, sub, mode, burst = 'var(--zi-red)') {
    this.clearFx();
    const el = document.createElement('div');
    el.className = `sfx ${mode}`;
    el.innerHTML = `${burstSVG(burst)}<b>${esc(word)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}`;
    this.fx.appendChild(el);
    if (mode === 'slam') setTimeout(() => el.remove(), 1600);
  }

  /** Where the kart should be right now (path units). */
  target() {
    const w = this.w;
    if (!w) return 0;
    const seg = this.L / this.n;
    const k = w.laps.length;
    if (w.status === 'idle') return 0;
    const lap = lapElapsed(w, capT(this.state, serverNow()));
    const avg = k ? w.laps.reduce((a, b) => a + b, 0) / k : 20000;
    const frac = 0.9 * (1 - Math.exp(-lap / (avg * 0.6)));
    return (k + frac) * seg;
  }

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.w) return;
    const tgt = this.target();
    if (now > this.spinUntil - 450 || this.d < tgt) {
      this.d += (tgt - this.d) * (1 - Math.exp(-dt * 4));
    }
    const { x, y, angle } = this.at(this.d);
    this.kart.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${((angle * 180) / Math.PI).toFixed(1)})`);
    const moving = this.w.status === 'running' || Math.abs(tgt - this.d) > 2;
    if (moving && now - this.lastPuff > 110) {
      this.lastPuff = now;
      const px = x - Math.cos(angle) * 24 + (Math.random() - 0.5) * 4;
      const py = y - Math.sin(angle) * 24 + (Math.random() - 0.5) * 4;
      const puff = svgEl('circle', { cx: px.toFixed(1), cy: py.toFixed(1), r: 4, fill: 'rgba(255,246,232,.55)', class: 'puff' });
      this.puffs.appendChild(puff);
      setTimeout(() => puff.remove(), 700);
    }
  }
}
