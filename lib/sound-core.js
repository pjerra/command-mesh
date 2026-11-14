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
// Jazz at a chosen tempo (default 92 BPM, 70-120). The grid is 8th notes (8 per 4/4 bar), swung 2:1: an odd step lands 2/3 of a beat in.
// One chord per bar: Dm9 - G13 - Cmaj9 - A7(b9). There is NO global scale: every note any instrument
// plays (activity, event motifs) is picked from the allowed set of the chord sounding at that step.
function musClampBpm(b) {
  b = Math.round(Number(b));
  return Number.isFinite(b) ? Math.max(70, Math.min(120, b)) : 92;
}
function musConst(bpm) {
  bpm = bpm === undefined ? 92 : Math.max(70, Math.min(120, Math.round(Number(bpm)) || 92));
  return {
    BPM: bpm, BEAT: 60 / bpm, SWING: 2 / 3, BAR_STEPS: 8, RELEASE: 0.06, MAX_NEW: 3,
    // tones = root 3 5 7 9; set = tones + that chord's own safe tension; comp = rootless 3-7-9 (pitch classes).
    CHORDS: [
      { name: 'Dm9', root: 2, tones: [2, 5, 9, 0, 4], set: [2, 5, 9, 0, 4, 7], comp: [5, 0, 4] },
      { name: 'G13', root: 7, tones: [7, 11, 2, 5, 9], set: [7, 11, 2, 5, 9, 4], comp: [11, 5, 9] },
      { name: 'Cmaj9', root: 0, tones: [0, 4, 7, 11, 2], set: [0, 4, 7, 11, 2, 9], comp: [4, 11, 2] },
      { name: 'A7b9', root: 9, tones: [9, 1, 4, 7, 10], set: [9, 1, 4, 7, 10, 0], comp: [1, 7, 10] }
    ],
    // Strictly separate registers (MIDI): bass E1-B2, Rhodes C3-F4, vibes F#4-E5, trumpet F5-G6.
    RANGE: { codex: [28, 47], claude: [48, 65], omp: [66, 76], gemini: [77, 91] },
    // Length of a played note, in beats (cut at the bar line anyway).
    BEATS: { codex: 0.8, claude: 0.35, omp: 1.2, gemini: 1.6 },
    PRIO: { codex: 0, gemini: 1, omp: 2, claude: 3, drums: 9 }
  };
}
// Start time (s) of an 8th-note step with swing, given the clock origin t0.
function musStepTime(step, t0, bpm) {
  const M = musConst(bpm), beat = Math.floor(step / 2);
  return t0 + (beat + (step % 2 ? M.SWING : 0)) * M.BEAT;
}
// Index of the first step whose time is at or after t.
function musNextStep(t, t0, bpm) {
  const M = musConst(bpm), beats = Math.max(0, (t - t0) / M.BEAT), n = Math.floor(beats + 1e-9), frac = beats - n;
  if (frac <= 1e-9) return 2 * n;
  return frac <= M.SWING + 1e-9 ? 2 * n + 1 : 2 * n + 2;
}
function musNextGrid(t, t0, bpm) { return musStepTime(musNextStep(t, t0, bpm), t0, bpm); }
// Change tempo without moving the grid: returns the new clock origin t0 so that `step` (a bar line)
// sounds at exactly the same time as before. Steps keep their numbers, so chords stay on their bars.
function musRetempo(step, t0, oldBpm, newBpm) {
  return musStepTime(step, t0, oldBpm) - musStepTime(step, 0, newBpm);
}
// Chord (progression cycles forever, one per bar) active at a given step.
function musChordIndex(step) {
  const M = musConst();
  return Math.floor(Math.max(0, step) / M.BAR_STEPS) % M.CHORDS.length;
}
// Seconds a note may last: wanted length, but released RELEASE s before the next bar line.
function musNoteLen(step, t0, want, bpm) {
  const M = musConst(bpm), end = musStepTime((Math.floor(step / M.BAR_STEPS) + 1) * M.BAR_STEPS, t0, bpm);
  return Math.max(0.05, Math.min(want, end - musStepTime(step, t0, bpm) - M.RELEASE));
}
// Can this instrument start an activity note on this step? bass: every beat; trumpet: every beat;
// Rhodes: syncopated stabs (1, "and of 2", "and of 3"); vibes: any 8th.
function musAllowed(core, step) {
  const s = ((step % 8) + 8) % 8;
  if (core === 'codex' || core === 'gemini') return s % 2 === 0;
  if (core === 'claude') return s === 0 || s === 3 || s === 5;
  return true;
}
// Candidate MIDI notes for an instrument in its own register, from the CURRENT chord only.
// kind: 'tones' (root 3 5 7 9) | 'set' (tones + the chord's own tension) | 'root' | 'fifth'.
function musPool(core, chordIdx, kind) {
  const M = musConst(), ch = M.CHORDS[chordIdx], r = M.RANGE[core] || M.RANGE.claude, out = [];
  const pcs = kind === 'set' ? ch.set : kind === 'root' ? [ch.root] : kind === 'fifth' ? [ch.tones[2]] : ch.tones;
  for (let m = r[0]; m <= r[1]; m++) if (pcs.indexOf(m % 12) >= 0) out.push(m);
  return out;
}
// Rootless 3-7-9 Rhodes voicing, closest inversion to the previous voicing (voice-leading).
function musVoicing(chordIdx, prev) {
  const M = musConst(), comp = M.CHORDS[chordIdx].comp, lo = M.RANGE.claude[0], hi = M.RANGE.claude[1];
  let best = null, bestCost = 1e9;
  for (let rot = 0; rot < 3; rot++) {
    const pcs = comp.slice(rot).concat(comp.slice(0, rot));
    for (const base of [lo, lo + 12]) {
      const v = [];
      let from = base;
      for (const pc of pcs) { let m = from; while (m % 12 !== pc) m++; v.push(m); from = m + 1; }
      if (v[2] > hi || v[1] - v[0] < 2 || v[2] - v[1] < 2) continue; // in range, no semitone cluster
      let cost;
      if (prev && prev.length === 3) cost = v.reduce((a, m, i) => a + Math.abs(m - prev[i]), 0);
      else cost = Math.abs((v[0] + v[2]) / 2 - 55);
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
  }
  return best;
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
// Notes (MIDI numbers) an instrument plays now for activity. `st` is its small memory.
function musPick(core, st, step) {
  const M = musConst(), ci = musChordIndex(step), bar = Math.floor(Math.max(0, step) / M.BAR_STEPS);
  if (core === 'claude') {
    if (st.bar !== bar) { st.v = musVoicing(ci, st.v); st.bar = bar; }
    return st.v.slice();
  }
  if (core === 'codex') {
    const pool = musPool('codex', ci, 'tones');
    if (step % 8 === 0) { // bar line: the root, closest to where the line was
      const roots = musPool('codex', ci, 'root'), from = st.last === undefined ? 36 : st.last;
      st.last = roots.reduce((a, m) => (Math.abs(m - from) < Math.abs(a - from) ? m : a), roots[0]);
      return [st.last];
    }
    return [pool[musWalk(st, pool)]];
  }
  if (core === 'omp') {
    const pool = musPool('omp', ci, step % 2 === 0 ? 'tones' : 'set'); // chord tones on the beat, tension off it
    return [pool[musWalk(st, pool)]];
  }
  const pool = musPool('gemini', ci, 'tones');
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
// Soft drum pattern: brush swish on 2 and 4, ride on 1, 2, "and of 2", 3, 4, "and of 4".
function musDrumHit(step) {
  const s = ((step % 8) + 8) % 8, brush = s === 2 || s === 6, ride = [0, 2, 3, 4, 6, 7].indexOf(s) >= 0;
  return brush || ride ? { brush, ride } : null;
}
// Pick one event-motif note from the CURRENT chord at the moment it sounds. `st` is shared by the notes of one motif.
function musEventNote(pick, chordIdx, inst, st) {
  const M = musConst(), r = M.RANGE[inst];
  let m;
  if (pick.k === 'tone') { const p = musPool(inst, chordIdx, 'tones'); m = p[Math.max(0, Math.min(p.length - 1, pick.i))]; }
  else if (pick.k === 'root') { const p = musPool(inst, chordIdx, 'root'); m = p.reduce((a, x) => (Math.abs(x - 36) < Math.abs(a - 36) ? x : a), p[0]); }
  else if (pick.k === 'fifth') m = musPool(inst, chordIdx, 'fifth')[0];
  else { // 'above': the next allowed note up from the last one (the 6th when the chord allows it), else down
    const p = musPool(inst, chordIdx, 'set'), up = p.filter(x => x > st.last), dn = p.filter(x => x < st.last);
    m = up.length ? up[0] : dn[dn.length - 1];
  }
  st.last = m;
  return Math.max(r[0], Math.min(r[1], m));
}
// What plays on this 8th step. `pending` = activity events waiting per core (consumed for cores that play);
// `phrases` = queued event-motif notes (consumed when due; postponed one step if the density cap is full);
// opts.drums = brushes/ride on. Rules: max 1 note per instrument per step, max MAX_NEW instruments with a NEW note.
function musStepPlan(pending, mem, step, phrases, opts) {
  const M = musConst(), ci = musChordIndex(step), out = [], used = {};
  const ph = phrases || [];
  for (let i = ph.length - 1; i >= 0; i--) if (ph[i].step < step) ph.splice(i, 1);
  const due = ph.filter(p => p.step === step).sort((a, b) => M.PRIO[a.inst] - M.PRIO[b.inst]);
  for (const p of due) {
    if (used[p.inst] || out.length >= M.MAX_NEW) { p.step = step + 1; continue; }
    used[p.inst] = 1;
    ph.splice(ph.indexOf(p), 1);
    out.push({ core: p.inst, glow: p.glow, notes: [musEventNote(p.pick, ci, p.inst, p.grp)], vel: p.vel, merged: 1, beats: p.beats, event: true });
  }
  for (const core of ['codex', 'gemini', 'omp', 'claude']) {
    const n = pending[core] || 0;
    if (n <= 0 || used[core] || !musAllowed(core, step) || out.length >= M.MAX_NEW) continue; // waits: becomes velocity later
    mem[core] = mem[core] || {};
    used[core] = 1;
    out.push({ core, glow: core, notes: musPick(core, mem[core], step), vel: musVelocity(n), merged: n, beats: M.BEATS[core] });
    pending[core] = 0;
  }
  const d = opts && opts.drums ? musDrumHit(step) : null;
  if (d && out.length < M.MAX_NEW) out.push({ core: 'drums', notes: [], vel: 1, merged: 1, beats: 0.3, brush: d.brush, ride: d.ride });
  return out;
}
// Event motifs in jazz terms. Returns [{step, inst, glow, pick, vel, beats, grp}] (absolute 8th steps from `start`).
// Pitches are NOT fixed here: each is chosen from the current chord when it sounds (musEventNote).
function musPhrase(type, start, glow) {
  const grp = {}, B = musConst().BEATS;
  const mk = (off, inst, pick, vel, beats) => ({ step: start + off, inst, glow: glow || inst, pick, vel, beats: beats || B[inst], grp });
  const t = i => ({ k: 'tone', i });
  if (type === 'done') return [[0, 0], [1, 1], [2, 2], [3, 3], [4, 2], [6, 1]].map(x => mk(x[0], 'omp', t(x[1]), 0.85, x[0] === 6 ? 2 : 0.7)); // short vibes lick up the chord and back down
  if (type === 'input') return [mk(0, 'gemini', { k: 'fifth' }, 0.8, 1), mk(3, 'gemini', { k: 'above' }, 0.8, 1.6)]; // trumpet question: 5th up to the 6th
  if (type === 'error') return [mk(0, 'codex', { k: 'root' }, 0.7, 1)]; // soft bass root
  if (type === 'alert') return [[0, 1], [2, 2], [4, 3]].map(x => mk(x[0], 'omp', t(x[1]), 0.8, 1.2)); // three vibes notes
  if (type === 'session') return [0, 1, 2, 3, 4].map(i => mk(i, 'claude', t(i), 0.8, 0.5)); // quick Rhodes arpeggio up the chord
  return [];
}
// First step a motif may start on: always on a beat (even step).
function musPhraseStart(type, step) {
  return Math.ceil(step / 2) * 2;
}

const source = [soundEvents, planSounds, musClampBpm, musConst, musStepTime, musNextStep, musNextGrid, musRetempo, musChordIndex, musNoteLen, musAllowed, musPool, musVoicing, musWalk, musPick, musVelocity, musFullness, musDrumHit, musEventNote, musStepPlan, musPhrase, musPhraseStart].map(f => f.toString()).join('\n');

module.exports = { soundEvents, planSounds, musClampBpm, musConst, musStepTime, musNextStep, musNextGrid, musRetempo, musChordIndex, musNoteLen, musAllowed, musPool, musVoicing, musWalk, musPick, musVelocity, musFullness, musDrumHit, musEventNote, musStepPlan, musPhrase, musPhraseStart, source };
