'use strict';

// Pure, DOM-free logic for dashboard sounds. These functions are also injected into the page
// source via .toString(), so each must be self-contained (no references to outer variables).
// Only provider names, statuses, ids and counts are read; label text is never used for output
// (it is only matched against a pattern to spot "turn finished" markers).

function soundEvents(prev, state, now) {
  const CORES = ['claude', 'codex', 'omp', 'gemini'];
  const TURN = / working$|answer ready|turn complete/i;
  const NEED_MS = 12000;
  state = state || {};
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const rows = Array.isArray(state.sessions) ? state.sessions : [];
  const lim = state.limits || {};
  const mem = { ids: {}, sess: {}, running: {}, fired: {}, waiting: {} };
  const events = [];
  const primed = !!prev;
  const old = prev || { ids: {}, sess: {}, running: {}, fired: {}, waiting: {} };
  const core = e => (CORES.indexOf(e && e.provider) >= 0 ? e.provider : 'claude');

  for (const e of entries) {
    if (!e || e.id === undefined) continue;
    const id = String(e.id);
    mem.ids[id] = e.status;
    const was = old.ids[id];
    const bad = e.status === 'err' || e.status === 'block';
    const turn = TURN.test(String(e.label || ''));
    if (was === undefined) {
      if (!primed) continue;
      if (bad) events.push({ type: 'error', core: core(e) });
      else if (turn && e.status === 'ok') events.push({ type: 'done', core: core(e) });
      else if (!turn) events.push({ type: 'activity', core: core(e) });
    } else if (was === 'run' && e.status !== 'run' && primed) {
      if (bad) events.push({ type: 'error', core: core(e) });
      else if (turn && e.status === 'ok') events.push({ type: 'done', core: core(e) });
    }
  }

  // Sessions: new session appears; agent finishes (had running work, now none).
  const runningNow = {};
  for (const r of rows) {
    if (!r || r.key === undefined) continue;
    mem.sess[String(r.key)] = 1;
    if (primed && !old.sess[String(r.key)]) events.push({ type: 'session', core: core(r) });
    if (r.running && !r.sub) runningNow[core(r)] = (runningNow[core(r)] || 0) + 1;
  }
  for (const c of CORES) {
    mem.running[c] = runningNow[c] || 0;
    if (primed && (old.running[c] || 0) > 0 && !mem.running[c]) events.push({ type: 'done', core: c });
  }

  // Needs input (heuristic): a tool call has been open for NEED_MS with nothing newer from that core.
  for (const c of CORES) {
    const mine = entries.filter(e => e && core(e) === c);
    const last = mine[mine.length - 1];
    const waiting = !!last && last.status === 'run' && !TURN.test(String(last.label || '')) &&
      typeof last.startedAt === 'number' && now - last.startedAt >= NEED_MS && now - last.startedAt < 600000;
    mem.waiting[c] = waiting ? String(last.id) : '';
    if (primed && waiting && old.waiting[c] !== String(last.id)) events.push({ type: 'input', core: c });
  }

  // Limit alerts: once per (account, window, reset, threshold).
  for (const source of ['claude', 'codex', 'omp']) {
    const entry = lim[source];
    if (!entry || !Array.isArray(entry.accounts)) continue;
    for (const account of entry.accounts) {
      if (!account || !Array.isArray(account.windows)) continue;
      for (const w of account.windows) {
        if (!w) continue;
        const pct = Number(w.usedPercent) || 0;
        const exhausted = !!w.exhausted || pct >= 100;
        const eta = Number(w.etaMs) || 0;
        const base = source + '|' + String(account.name || '') + '|' + String(w.label || '') + '|' + String(w.resetsAt || '');
        if (eta > 0 && eta < 2 * 3600e3 && !exhausted) {
          mem.fired[base + '|eta'] = 1;
          if (primed && !old.fired[base + '|eta']) events.push({ type: 'alert', core: source });
        }
        if (pct >= 80 || exhausted) {
          const t = exhausted ? 100 : pct >= 95 ? 95 : 80;
          mem.fired[base + '|' + t] = 1;
          if (primed && !old.fired[base + '|' + t]) events.push({ type: 'alert', core: source });
        }
      }
    }
  }
  // Keep alert memory sticky so a flapping value cannot replay an alert.
  for (const k of Object.keys(old.fired)) mem.fired[k] = 1;
  return { mem, events };
}

// Decide which events actually play. `gate` is a plain object you keep between calls (use {}).
// Rules: activity blips merge into one per call and max 4 per rolling second; "input" at most once
// per 30s; other kinds are de-duplicated per core+type within 1.5s; alerts always pass (the
// event stream already makes them once per alert). Disabled kinds (opts.enabled[kind]===false) are dropped.
function planSounds(events, gate, now, enabled) {
  const KIND = { activity: 'activity', done: 'done', input: 'input', error: 'error', alert: 'alert', session: 'session' };
  enabled = enabled || {};
  gate.blips = (gate.blips || []).filter(t => now - t < 1000);
  gate.last = gate.last || {};
  gate.lastInput = gate.lastInput === undefined ? -Infinity : gate.lastInput;
  const out = [];
  let blipped = false;
  const rank = { alert: 0, input: 1, error: 2, done: 3, session: 4, activity: 5 };
  const sorted = (events || []).slice().sort((a, b) => rank[a.type] - rank[b.type]);
  for (const ev of sorted) {
    if (!KIND[ev.type] || enabled[ev.type] === false) continue;
    if (ev.type === 'activity') {
      if (blipped || gate.blips.length >= 4) continue;
      blipped = true;
      gate.blips.push(now);
      out.push(ev);
      continue;
    }
    if (ev.type === 'input') {
      if (now - gate.lastInput < 30000) continue;
      gate.lastInput = now;
      out.push(ev);
      continue;
    }
    if (ev.type !== 'alert') {
      const key = ev.type + '|' + ev.core;
      if (gate.last[key] !== undefined && now - gate.last[key] < 1500) continue;
      gate.last[key] = now;
    }
    out.push(ev);
  }
  return out;
}

const source = [soundEvents, planSounds].map(f => f.toString()).join('\n');

module.exports = { soundEvents, planSounds, source };
