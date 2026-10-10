// Live state from the server + clock math shared by the display and admin pages.

const offsets = [];
let offset = 0;

/** Track server-minus-client clock offset. Latency only ever makes a sample too small, so keep the max of recent samples. */
export function syncClock(serverNow) {
  offsets.push(serverNow - Date.now());
  if (offsets.length > 30) offsets.shift();
  offset = Math.max(...offsets);
}

export const serverNow = () => Date.now() + offset;

export function connect(onState, onStatus) {
  let es;
  let lastVersion = -1;
  const open = () => {
    es = new EventSource('/api/events');
    es.onopen = () => onStatus(true);
    es.onmessage = (e) => {
      const state = JSON.parse(e.data);
      syncClock(state.serverNow);
      if (state.version === lastVersion) return;
      lastVersion = state.version;
      onState(state);
    };
    es.onerror = () => {
      onStatus(false);
      // EventSource retries on its own; recreate only if the browser gave up.
      if (es.readyState === EventSource.CLOSED) setTimeout(open, 1500);
    };
  };
  open();
  return {
    /** Feed a snapshot that arrived another way (e.g. an action response). */
    push(state) {
      syncClock(state.serverNow);
      if (state.version <= lastVersion) return;
      lastVersion = state.version;
      onState(state);
    },
  };
}

// ---------- time math ----------

export function clockElapsed(clock, t = serverNow()) {
  return clock.accum + (clock.since != null ? Math.max(0, t - clock.since) : 0);
}

export function clockRemaining(clock, t = serverNow()) {
  return Math.max(0, clock.durationMs - clockElapsed(clock, t));
}

/** Current (unfinished) lap time of a stopwatch. */
export function lapElapsed(watch, t = serverNow()) {
  return watch.accum + (watch.status === 'running' && watch.since != null ? Math.max(0, t - watch.since) : 0);
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Clamp a running stopwatch to the moment the match clock ran out, so nothing overshoots 10:00 between snapshots. */
export function capT(state, t = serverNow()) {
  const c = state.clock;
  if (c.since == null) return t;
  return Math.min(t, c.since + (c.durationMs - c.accum));
}

// ---------- formatting ----------

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Stopwatch format: 01:23.45 (hundredths). */
export function fmtLap(ms) {
  ms = Math.max(0, Math.floor(ms));
  const cs = Math.floor(ms / 10) % 100;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000);
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** Countdown format: 09:59, then 00:09.4 in the last ten seconds. */
export function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  if (ms < 10000) return `00:0${Math.floor(ms / 1000)}.${Math.floor(ms / 100) % 10}`;
  const total = Math.ceil(ms / 1000);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export const ROUND_NAMES = {
  16: ['Round of 16', 'Knockouts'],
  8: ['Round of 8', 'Quarter-finals'],
  4: ['Round of 4', 'Semi-finals'],
  2: ['The Final', 'Round of 2'],
};

export function fmtScore(best) {
  if (!best) return '—';
  return `${best.checkpoints} CP · ${fmtLap(best.scoreMs)}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function teamById(state, id) {
  return state.teams.find((t) => t.id === id);
}
