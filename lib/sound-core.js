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

// ---- Music theory: pure helpers (also injected into the page; self-contained, call each other by name). ----
// Key: C major pentatonic (C D E G A). Progression Am - F - C - G, each chord lasts 2 bars (32 sixteenths).
function musConst() {
  return {
    BPM: 96, STEP: 60 / 96 / 4, CHORD_STEPS: 32,
    PENT: [0, 2, 4, 7, 9],
    CHORDS: [
      { name: 'Am', root: 9, fifth: 4, pcs: [9, 0, 4] },
      { name: 'F', root: 5, fifth: 0, pcs: [5, 9, 0] },
      { name: 'C', root: 0, fifth: 7, pcs: [0, 4, 7] },
      { name: 'G', root: 7, fifth: 2, pcs: [7, 11, 2] }
    ],
    RANGE: { codex: [36, 55], claude: [55, 76], omp: [60, 84], gemini: [72, 96] },
    EVERY: { codex: 4, claude: 4, omp: 1, gemini: 2 }
  };
}
// Time of the next grid step at or after t (seconds), given the clock origin t0.
function musNextGrid(t, t0) {
  const S = musConst().STEP;
  const n = Math.ceil((t - t0) / S - 1e-9);
  return t0 + Math.max(0, n) * S;
}
// Index of the next grid step at or after t.
function musNextStep(t, t0) {
  return Math.max(0, Math.ceil((t - t0) / musConst().STEP - 1e-9));
}
// Chord (progression cycles forever) active at a given step.
function musChordIndex(step) {
  const M = musConst();
  return Math.floor(Math.max(0, step) / M.CHORD_STEPS) % M.CHORDS.length;
}
// Can this instrument sound on this step? (bass and chords on beats, gemini on eighths, omp on any 16th)
function musAllowed(core, step) {
  const e = musConst().EVERY[core] || 1;
  return step % e === 0;
}
// Candidate MIDI notes for an instrument: chord tones, plus pentatonic passing notes if `passing`.
function musPool(core, chordIdx, passing) {
  const M = musConst(), ch = M.CHORDS[chordIdx], r = M.RANGE[core] || M.RANGE.claude, out = [];
  for (let m = r[0]; m <= r[1]; m++) {
    const pc = m % 12;
    if (ch.pcs.indexOf(pc) >= 0 || (passing && M.PENT.indexOf(pc) >= 0)) out.push(m);
  }
  return out;
}
// Walk one step along a pool from the last note (bouncing at the ends): a phrase, not random jumps.
function musWalk(st, pool) {
  let idx = 0, best = 1e9;
  const from = st.last === undefined ? (pool[0] + pool[pool.length - 1]) / 2 : st.last;
  for (let i = 0; i < pool.length; i++) { const d = Math.abs(pool[i] - from); if (d < best) { best = d; idx = i; } }
  if (st.last !== undefined) {
    let dir = st.dir === -1 ? -1 : 1;
    if (idx + dir < 0 || idx + dir >= pool.length) dir = -dir;
    idx = Math.max(0, Math.min(pool.length - 1, idx + dir));
    st.dir = dir;
  }
  st.last = pool[idx];
  return idx;
}
// Notes (MIDI numbers) an instrument plays now. `st` is its small memory {last, dir, alt}.
function musPick(core, st, step) {
  const M = musConst(), ci = musChordIndex(step), ch = M.CHORDS[ci];
  if (core === 'codex') {
    st.alt = (st.alt || 0) + 1;
    const want = st.alt % 2 === 1 ? ch.root : ch.fifth, aim = st.alt % 2 === 1 ? 43 : 47;
    let best = -1;
    for (let m = M.RANGE.codex[0]; m <= M.RANGE.codex[1]; m++) if (m % 12 === want && (best < 0 || Math.abs(m - aim) < Math.abs(best - aim))) best = m;
    st.last = best;
    return [best];
  }
  if (core === 'claude') {
    const pool = musPool('claude', ci, false);
    let i = musWalk(st, pool);
    i = Math.max(0, Math.min(pool.length - 3, i));
    return [pool[i], pool[i + 1], pool[i + 2]];
  }
  const passing = core === 'omp' ? step % 2 === 1 : step % 4 === 2;
  const pool = musPool(core, ci, passing);
  return [pool[musWalk(st, pool)]];
}
// Velocity (0.5..1) from how many events were merged into one note.
function musVelocity(count) {
  return Math.min(1, 0.55 + 0.15 * (Math.max(1, count) - 1));
}
// Overall loudness from the number of agents working (crescendo as more join).
function musFullness(n) {
  return Math.min(1, 0.55 + 0.15 * Math.max(0, n));
}
// What plays on this grid step. `pending` = events waiting per core ({claude: 3, ...}); it is consumed
// (set to 0) for every instrument that plays. At most one note event per instrument per step.
function musStepPlan(pending, mem, step) {
  const out = [];
  for (const core of ['claude', 'codex', 'omp', 'gemini']) {
    const n = pending[core] || 0;
    if (n <= 0 || !musAllowed(core, step)) continue;
    mem[core] = mem[core] || {};
    out.push({ core, notes: musPick(core, mem[core], step), vel: musVelocity(n), merged: n });
    pending[core] = 0;
  }
  return out;
}
// Event phrases, in key. Returns [{step, midi, len}] with absolute steps starting at `start`.
function musPhrase(type, start) {
  let spec;
  if (type === 'done') spec = [[0, 67, 2], [1, 71, 2], [2, 74, 2], [3, 79, 2], [4, 72, 2], [5, 76, 2], [6, 79, 2], [7, 84, 8]]; // V (G B D G) then I (C E G C)
  else if (type === 'input') spec = [[0, 74, 4], [3, 76, 8]]; // D -> E, rising second
  else if (type === 'error') spec = [[0, 57, 3]]; // soft low A
  else if (type === 'alert') spec = [[0, 88, 4], [2, 91, 4], [4, 93, 8]]; // E G A bells
  else if (type === 'session') spec = [[0, 72, 2], [1, 74, 2], [2, 76, 2], [3, 79, 2], [4, 81, 2], [5, 84, 4]]; // gliss up the scale
  else return [];
  return spec.map(x => ({ step: start + x[0], midi: x[1], len: x[2] }));
}
// First step a phrase of this type may start on: input waits for a beat, others for the next 16th.
function musPhraseStart(type, step) {
  return type === 'input' ? Math.ceil(step / 4) * 4 : step;
}

const source = [soundEvents, planSounds, musConst, musNextGrid, musNextStep, musChordIndex, musAllowed, musPool, musWalk, musPick, musVelocity, musFullness, musStepPlan, musPhrase, musPhraseStart].map(f => f.toString()).join('\n');

module.exports = { soundEvents, planSounds, musConst, musNextGrid, musNextStep, musChordIndex, musAllowed, musPool, musWalk, musPick, musVelocity, musFullness, musStepPlan, musPhrase, musPhraseStart, source };
