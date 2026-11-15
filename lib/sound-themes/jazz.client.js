// Sound theme "Jazz": the generative swing-jazz engine. One shared swung 8th-note clock (default 92 BPM,
// tempo slider 70-120), one chord per bar (Dm9 - G13 - Cmaj9 - A7b9), every note picked from the chord
// sounding at that step, separate instrument registers, every note cut before the bar line.
// The pure music maths (mus* functions) lives in lib/sound-core.js; this file is the Web Audio part.
// Tempo changes wait for the next bar line, so a bar never has two tempos and the cuts stay right.
const sndPending = {}, sndVoices = {}, sndPhrases = [], sndLfos = [];
let sndT0 = 0, sndNext = 0, sndTimer = null, sndBpm = 92, sndNewBpm = 0;
let sndBus = null, sndDrumBus = null, sndRhodesBus = null, sndVibesBus = null, sndNoise = null;
// A short, dark room (about half a second) for a little warmth.
function sndImpulse(c) {
  const len = Math.floor(c.sampleRate * 0.5), buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  return buf;
}
// Slow LFO that wobbles an AudioParam (tremolo / vibrato). Guarded: skipped if the API is missing.
// Bus LFOs (no `to`) are remembered so stop() can end them.
function sndLfo(c, rate, depth, param, from, to) {
  try {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = rate; g.gain.value = depth;
    o.connect(g); g.connect(param); o.start(from || 0); if (to) o.stop(to); else sndLfos.push(o);
  } catch {}
}
function sndHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
// One partial: absolute start time t, length, peak gain, attack, optional destination. Ends at t+len+0.05 at the latest.
function sndTone(f, t, len, type, peak, att, dest) {
  const c = sndCtx, o = c.createOscillator(), g = c.createGain();
  att = Math.min(att, len * 0.6);
  o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + att);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g); g.connect(dest || sndBus); o.start(t); o.stop(t + len + 0.05);
}
// Instruments. `cap` = longest this note may last (it is cut before the next bar line).
// codex = upright bass (plucked, warm, short); claude = Rhodes (soft tremolo bus); omp = vibraphone
// (sine + partials, motor on its bus, soft mallet); gemini = muted trumpet (filtered saw+square, breathy, vibrato).
const SND_INST = {
  codex: (f, t, v, cap) => { sndTone(f, t, Math.min(0.7, cap), 'sine', 0.2 * v, 0.01); sndTone(f * 2, t, Math.min(0.2, cap), 'triangle', 0.05 * v, 0.006); sndTone(f * 3, t, Math.min(0.06, cap), 'sine', 0.02 * v, 0.003); },
  claude: (f, t, v, cap) => { sndTone(f, t, Math.min(0.5, cap), 'sine', 0.07 * v, 0.008, sndRhodesBus); sndTone(f * 2, t, Math.min(0.25, cap), 'sine', 0.02 * v, 0.005, sndRhodesBus); sndTone(f * 6, t, Math.min(0.05, cap), 'sine', 0.008 * v, 0.002, sndRhodesBus); },
  omp: (f, t, v, cap) => { sndTone(f, t, Math.min(1.4, cap), 'sine', 0.08 * v, 0.012, sndVibesBus); sndTone(f * 4, t, Math.min(0.35, cap), 'sine', 0.018 * v, 0.008, sndVibesBus); sndTone(f * 10, t, Math.min(0.08, cap), 'sine', 0.006 * v, 0.004, sndVibesBus); },
  gemini: (f, t, v, cap) => {
    const c = sndCtx, len = Math.min(1.5, cap), end = t + len + 0.05;
    let dest = sndBus;
    if (typeof c.createBiquadFilter === 'function') {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 3;
      lp.frequency.setValueAtTime(700, t); lp.frequency.linearRampToValueAtTime(1900, t + 0.12); lp.frequency.linearRampToValueAtTime(1300, t + len);
      lp.connect(sndBus); dest = lp;
    }
    const att = Math.min(0.07, len * 0.5);
    [['sawtooth', 0.04], ['square', 0.02]].forEach(([type, peak]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak * v, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(dest);
      if (o.detune) sndLfo(c, 5.2, 7, o.detune, t + Math.min(0.15, len * 0.4), end); // slight vibrato once the note has bloomed
      o.start(t); o.stop(end);
    });
  }
};
// Brushes on 2 and 4 plus soft ride pings. Very quiet, only while something is working.
function sndDrums(p, t, v, cap) {
  const c = sndCtx, len = Math.min(0.22, cap);
  if (p.brush && typeof c.createBufferSource === 'function' && typeof c.createBiquadFilter === 'function') {
    try {
      if (!sndNoise) { sndNoise = c.createBuffer(1, Math.floor(c.sampleRate * 0.3), c.sampleRate); const d = sndNoise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = sndNoise; f.type = 'bandpass'; f.frequency.value = 5500; f.Q.value = 0.7;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05 * v, t + len * 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      s.connect(f); f.connect(g); g.connect(sndDrumBus); s.start(t); s.stop(t + len + 0.05);
    } catch {}
  }
  if (p.ride) [3300, 4900, 6700].forEach((hz, i) => sndTone(hz, t, Math.min(0.3, cap), 'square', (p.brush ? 0.005 : 0.007) * v / (i + 1), 0.002, sndDrumBus));
}
function sndPlay(p, step, when, full) {
  const cap = musNoteLen(step, sndT0, p.beats * 60 / sndBpm, sndBpm);
  if (p.core === 'drums') { sndDrums(p, when, full, cap); return; }
  p.notes.forEach(m => {
    SND_INST[p.core](sndHz(m), when, p.vel * full, cap);
    if (sndTrace) sndTrace({ inst: p.core, midi: m, step, when, len: cap, event: !!p.event, bpm: sndBpm, t0: sndT0 });
  });
  sndGlowAt(p.glow || p.core, when);
}
// Lookahead scheduler: runs every 25ms, schedules every step that falls in the next 150ms.
function sndSchedule() {
  const c = sndCtx;
  if (!c || sndTimer === null) return;
  const horizon = c.currentTime + 0.15;
  const live = c.state === 'running' && !snd.muted && snd.volume > 0;
  const drums = live && snd.enabled.drums && sndWorking > 0;
  if (sndDrumBus) sndDrumBus.gain.setTargetAtTime(drums ? 1 : 0, c.currentTime, 0.8);
  const due = musNextStep(c.currentTime, sndT0, sndBpm);
  if (sndNext < due - 8) sndNext = due; // tab was asleep: skip ahead instead of bursting
  for (;;) {
    // A new tempo starts on a bar line: re-anchor the clock so that bar line keeps its time.
    if (sndNewBpm && sndNext % 8 === 0) { sndT0 = musRetempo(sndNext, sndT0, sndBpm, sndNewBpm); sndBpm = sndNewBpm; sndNewBpm = 0; }
    if (musStepTime(sndNext, sndT0, sndBpm) >= horizon) break;
    const step = sndNext++, when = musStepTime(step, sndT0, sndBpm);
    if (!live) { sndPhrases.length = 0; for (const k of SND_CORES) sndPending[k] = 0; continue; }
    if (when < c.currentTime - 0.02) continue;
    const full = musFullness(sndWorking);
    musStepPlan(sndPending, sndVoices, step, sndPhrases, { drums }).forEach(p => sndPlay(p, step, when, full));
  }
}
// Queue an event motif on the grid, on a beat. Pitches are chosen later, from the chord sounding at that step.
function sndQueuePhrase(ev) {
  if (sndTimer === null) return;
  const core = SND_CORES.includes(ev.core) ? ev.core : 'claude';
  const start = musPhraseStart(ev.type, Math.max(sndNext, musNextStep(sndCtx.currentTime, sndT0, sndBpm)));
  musPhrase(ev.type, start, core).forEach(n => sndPhrases.push(n));
}
sndRegister({
  id: 'jazz', name: 'Jazz', order: 1, mergesActivity: true, drums: true, tempo: { min: 70, max: 120 },
  start() {
    const c = sndCtx;
    if (!c || !sndOut) return;
    // voices -> bus -> (dry + short reverb) -> compressor -> warm low-pass -> theme output
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 20; comp.ratio.value = 6; comp.attack.value = 0.008; comp.release.value = 0.3;
    sndBus = c.createGain();
    const dry = c.createGain(), wet = c.createGain(), verb = c.createConvolver();
    dry.gain.value = 0.85; wet.gain.value = 0.16; verb.buffer = sndImpulse(c);
    sndBus.connect(dry); dry.connect(comp);
    sndBus.connect(verb); verb.connect(wet); wet.connect(comp);
    sndDrumBus = c.createGain(); sndDrumBus.gain.value = 0; sndDrumBus.connect(sndBus);
    sndRhodesBus = c.createGain(); sndRhodesBus.gain.value = 0.85; sndRhodesBus.connect(sndBus);
    sndVibesBus = c.createGain(); sndVibesBus.gain.value = 0.85; sndVibesBus.connect(sndBus);
    sndLfo(c, 4.2, 0.12, sndRhodesBus.gain);  // Rhodes: soft tremolo
    sndLfo(c, 5.0, 0.2, sndVibesBus.gain);    // vibes: motor
    if (typeof c.createBiquadFilter === 'function') {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3800; lp.Q.value = 0.5;
      comp.connect(lp); lp.connect(sndOut);
    } else comp.connect(sndOut);
    sndBpm = musClampBpm(snd.tempo); sndNewBpm = 0;
    sndT0 = c.currentTime + 0.1; sndNext = 0;
    sndTimer = setInterval(sndSchedule, 25);
  },
  stop() {
    if (sndTimer !== null) clearInterval(sndTimer);
    sndTimer = null;
    sndPhrases.length = 0;
    for (const k of SND_CORES) sndPending[k] = 0;
    for (const k of Object.keys(sndVoices)) delete sndVoices[k];
    sndLfos.splice(0).forEach(o => { try { o.stop(); } catch {} });
    sndBus = sndDrumBus = sndRhodesBus = sndVibesBus = null;
  },
  setTempo(bpm) { sndNewBpm = musClampBpm(bpm) === sndBpm ? 0 : musClampBpm(bpm); },
  onActivity(core) { if (sndTimer !== null) sndPending[core] = (sndPending[core] || 0) + 1; }, // merged into velocity at the next step
  onDone(core) { sndQueuePhrase({ type: 'done', core }); },
  onNeedsInput(core) { sndQueuePhrase({ type: 'input', core }); },
  onError(core) { sndQueuePhrase({ type: 'error', core }); },
  onAlert(core) { sndQueuePhrase({ type: 'alert', core }); },
  onNewSession(core) { sndQueuePhrase({ type: 'session', core }); }
});
