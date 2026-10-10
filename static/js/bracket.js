// Horizontal knockout tree, drawn at the panel's real pixel size so text stays readable.
// Played matches are in colour and the winner flows on with a green arrow; unplayed
// matches are grey. The last column is the final standings (1-4).
import { esc, fmtSigned } from './core.js';

function clip(name, max) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

const better = (a, b, n) => {
  if (!a) return false;
  if (!b) return true;
  const ca = Math.min(a.checkpoints, n);
  const cb = Math.min(b.checkpoints, n);
  return ca > cb || (ca === cb && a.scoreMs < b.scoreMs);
};

/** Final standings: champion, runner-up, then the two semi-final losers ordered by their semi score. */
function standings(rounds) {
  const final = rounds[rounds.length - 1].matches[0];
  const ranks = [null, null];
  if (final.status === 'done' && final.a && final.b) {
    const aWon = final.winnerId === final.a.id;
    ranks[0] = aWon ? final.a : final.b;
    ranks[1] = aWon ? final.b : final.a;
  }
  if (rounds.length >= 2) {
    const semis = rounds[rounds.length - 2].matches;
    const losers = semis.map((m) => {
      if (m.status !== 'done' || !m.a || !m.b) return null;
      return m.winnerId === m.a.id ? { team: m.b, best: m.bestB, n: m.checkpoints } : { team: m.a, best: m.bestA, n: m.checkpoints };
    });
    if (losers.every(Boolean)) {
      const [x, y] = losers;
      const xFirst = !better(y.best, x.best, Math.max(x.n, y.n));
      ranks.push(xFirst ? x.team : y.team, xFirst ? y.team : x.team);
    } else {
      ranks.push(null, null);
    }
  }
  return ranks;
}

export function bracketSVG(state, W, H) {
  const rounds = state.bracket;
  if (!rounds.length || W < 50 || H < 50) return '';
  const cols = rounds.length + 1;
  const colW = W / cols;
  const boxW = colW * 0.7;
  const gap = colW - boxW;
  const head = Math.min(48, Math.max(30, H * 0.06));
  const bodyH = H - head - 8;
  const first = rounds[0].matches.length;
  const slot = bodyH / first;
  const ROW = Math.max(24, Math.min(56, slot * 0.38));
  const BOX_H = ROW * 2;
  const font = Math.round(Math.min(ROW * 0.56, boxW / 13));
  const small = Math.max(11, Math.round(font * 0.7));
  const charW = font * 0.53;
  const scoreW = small * 0.62 * 9 + 14; // "-00:00.00" in mono
  const charsFor = (withScore) => Math.max(5, Math.floor((boxW - font * 1.8 - 10 - (withScore ? scoreW : 0)) / charW));
  const current = state.tournament.round;
  const champion = state.tournament.champion;

  const x = (k) => k * colW + 4;
  const cy = (i, count) => head + ((i + 0.5) * bodyH) / count;
  const rowY = (i, count, which) => cy(i, count) + (which === 'a' ? -ROW / 2 : ROW / 2);
  const text = (cls, tx, ty, body, anchor = 'start', size = font) =>
    `<text class="${cls}" x="${tx}" y="${ty}" text-anchor="${anchor}" dominant-baseline="central" style="font-size:${size}px">${body}</text>`;

  const heads = [];
  const boxes = [];
  const flows = [];

  rounds.forEach((r, k) => {
    const count = r.matches.length;
    const isCurrent = r.round === current && champion == null;
    heads.push(text(`br-head${isCurrent ? ' is-current' : ''}`, x(k) + boxW / 2, head / 2, esc(r.name), 'middle', Math.round(Math.min(22, head * 0.5))));
    r.matches.forEach((m, i) => {
      const played = m.status === 'done' || m.live;
      const top = cy(i, count) - BOX_H / 2;
      const cls = m.live ? 'br-box is-live' : played ? 'br-box is-played' : 'br-box is-future';
      const scored = m.status === 'done' && !m.bye;
      let rows = '';
      for (const which of ['a', 'b']) {
        const team = m[which];
        const y = top + (which === 'a' ? 0 : ROW);
        const mid = y + ROW / 2;
        const won = m.status === 'done' && team && team.id === m.winnerId;
        const lost = m.status === 'done' && team && !won;
        const best = which === 'a' ? m.bestA : m.bestB;
        const name = team ? esc(clip(team.name, charsFor(scored))) : m.bye ? 'BYE' : '?';
        rows += `
          <g class="br-row${won ? ' won' : ''}${lost ? ' lost' : ''}${!team ? ' empty' : ''}">
            <rect x="${x(k)}" y="${y}" width="${boxW}" height="${ROW}"/>
            ${won ? `<rect class="br-win-bar" x="${x(k)}" y="${y}" width="6" height="${ROW}"/>` : ''}
            ${team ? text('br-seed', x(k) + font * 0.95, mid, team.seed, 'middle', small) : ''}
            ${text('br-name', x(k) + font * 1.8, mid, name)}
            ${scored ? text('br-score', x(k) + boxW - 8, mid, best ? fmtSigned(best.scoreMs) : '—', 'end', small) : ''}
          </g>`;
      }
      boxes.push(`<g class="${cls}">${rows}<rect class="br-frame" x="${x(k)}" y="${top}" width="${boxW}" height="${BOX_H}"/>${m.live ? text('br-live', x(k) + boxW, top - small * 0.8, '● LIVE', 'end', small) : ''}</g>`);

      if (m.status !== 'done') return;
      const team = m.a?.id === m.winnerId ? 'a' : 'b';
      const y = rowY(i, count, team);
      const tx = x(k + 1) - 6;
      // the final's winner flows into rank 1 of the standings
      const ty = k + 1 < rounds.length ? rowY(i >> 1, rounds[k + 1].matches.length, i % 2 === 0 ? 'a' : 'b') : null;
      const right = x(k) + boxW;
      const midX = right + gap * 0.5;
      flows.push({ d: `M ${right} ${y} H ${midX} V ${ty ?? 'RANK1'} H ${tx}`, delay: (k * 0.35).toFixed(2) });
    });
  });

  // standings column
  const k = rounds.length;
  const ranks = standings(rounds);
  const rankH = Math.max(ROW, Math.min(64, ROW * 1.25));
  const rankGap = rankH * 0.35;
  const totalH = ranks.length * rankH + (ranks.length - 1) * rankGap;
  const rankTop = head + bodyH / 2 - totalH / 2;
  heads.push(text(`br-head${champion != null ? ' is-current' : ''}`, x(k) + boxW / 2, head / 2, 'Standings', 'middle', Math.round(Math.min(22, head * 0.5))));
  ranks.forEach((team, r) => {
    const y = rankTop + r * (rankH + rankGap);
    const known = team != null;
    boxes.push(`
      <g class="br-rank${known ? ' is-known' : ''}${r === 0 && known ? ' is-first' : ''}">
        <rect x="${x(k)}" y="${y}" width="${boxW}" height="${rankH}"/>
        <rect class="br-rank-num" x="${x(k)}" y="${y}" width="${rankH}" height="${rankH}"/>
        ${text('br-rank-n', x(k) + rankH / 2, y + rankH / 2, r + 1, 'middle', Math.round(rankH * 0.5))}
        ${text('br-rank-name', x(k) + rankH + 12, y + rankH / 2, known ? esc(clip(team.name, Math.floor((boxW - rankH - 20) / charW))) : '?')}
      </g>`);
  });
  const rank1Y = rankTop + rankH / 2;

  return `
    <svg class="bracket-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Tournament bracket">
      <defs>
        <marker id="br-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#4BE38A" stroke="#1C0509" stroke-width="1.5"/>
        </marker>
      </defs>
      ${heads.join('')}
      ${flows.map((f) => `<path class="br-flow win" style="animation-delay:${f.delay}s" d="${f.d.replace('RANK1', rank1Y)}" marker-end="url(#br-arrow)"/>`).join('')}
      ${boxes.join('')}
    </svg>`;
}

/** Keep a bracket drawn at its container's size, redrawing on resize or new data. */
export function mountBracket(wrap) {
  let state = null;
  let key = '';
  const draw = () => {
    if (!state || wrap.offsetParent === null) return;
    const { width, height } = wrap.getBoundingClientRect();
    const k = JSON.stringify([state.bracket, state.tournament.champion, state.tournament.round, Math.round(width), Math.round(height)]);
    if (k === key) return;
    key = k;
    wrap.innerHTML = bracketSVG(state, Math.floor(width), Math.floor(height));
  };
  new ResizeObserver(draw).observe(wrap);
  return {
    update(next) { state = next; draw(); },
    reset() { key = ''; },
  };
}
