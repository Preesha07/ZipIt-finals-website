// Live state from Supabase + clock math shared by the display and admin pages.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm';
import { SUPABASE_KEY, SUPABASE_URL } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const offsets = [];
let offset = 0;

/** Track server-minus-client clock offset. Latency only ever makes a sample too small, so keep the max of recent samples. */
export function syncClock(serverNow) {
  offsets.push(serverNow - Date.now());
  if (offsets.length > 30) offsets.shift();
  offset = Math.max(...offsets);
}

export const serverNow = () => Date.now() + offset;

/**
 * Keep onState fed with snapshots. Realtime announces every version bump of app_state;
 * a cheap version poll every few seconds covers a dropped socket or a sleeping laptop.
 */
export function connect(onState, onStatus) {
  let lastVersion = -1;
  let inflight = false;
  let again = false;

  const deliver = (state) => {
    if (!state) return;
    syncClock(state.serverNow);
    if (state.version <= lastVersion) return;
    lastVersion = state.version;
    onState(state);
  };

  async function refresh() {
    if (inflight) { again = true; return; }
    inflight = true;
    try {
      const { data, error } = await sb.rpc('zipit_snapshot');
      if (error) throw error;
      deliver(data);
      onStatus(true);
    } catch {
      onStatus(false);
    } finally {
      inflight = false;
      if (again) { again = false; refresh(); }
    }
  }

  sb.channel('zipit-state')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_state' }, (p) => {
      if (p.new?.version !== lastVersion) refresh();
    })
    .subscribe((status) => { if (status === 'SUBSCRIBED') refresh(); });

  setInterval(async () => {
    const { data, error } = await sb.from('app_state').select('version').eq('id', 1).single();
    if (error) { onStatus(false); return; }
    onStatus(true);
    if (data.version !== lastVersion) refresh();
  }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();

  return { push: deliver, refresh };
}

let lastTick = 0;
/** Nobody runs a server loop any more: whichever page sees the clock reach zero asks the database to apply the stop. */
export function tickIfDue(state) {
  const c = state.clock;
  if (!state.match || c.over || c.since == null || clockRemaining(c) > 0) return;
  if (Date.now() - lastTick < 1500) return;
  lastTick = Date.now();
  sb.rpc('zipit_tick').then(() => {}, () => {});
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

/** [title, subtitle] for a round, keyed by its bracket size. */
export function roundName(size) {
  if (size === 2) return ['The Final', 'Round of 2'];
  if (size === 4) return ['Semi-finals', 'Round of 4'];
  if (size === 8) return ['Quarter-finals', 'Round of 8'];
  return [`Round of ${size}`, 'Knockouts'];
}

/** Score time can dip below zero once the headstart is taken off. */
export function fmtSigned(ms) {
  return ms < 0 ? `−${fmtLap(-ms)}` : fmtLap(ms);
}

export function fmtHead(seconds) {
  return seconds ? `${+seconds.toFixed(2)}s` : '0s';
}

/** Score of an attempt: "6/6 CP · 01:00.30". */
export function fmtScore(best, checkpoints) {
  if (!best) return '—';
  return `${best.checkpoints}/${checkpoints} CP · ${fmtSigned(best.scoreMs)}`;
}

/** Parse "mm:ss.cc", "m:ss", "ss.cc" or "ss" into ms. NaN when it doesn't look like a time. */
export function parseTime(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d+(?:\.\d*)?)$/);
  if (!m) return NaN;
  return Math.round(((Number(m[1] || 0) * 60) + Number(m[2])) * 1000);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function teamById(state, id) {
  return state.teams.find((t) => t.id === id);
}
