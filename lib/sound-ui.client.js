// Browser-side sound engine. Injected into the dashboard page after lib/sound-core.js.
// Everything is synthesized with Web Audio; no audio files. Guarded so missing APIs never throw.
const SND_KEY = 'command-mesh-sound';
const SND_KINDS = [['activity', 'Activity blips'], ['done', 'Agent done'], ['input', 'Needs input'], ['error', 'Errors'], ['alert', 'Limit alerts'], ['session', 'New session'], ['drums', 'Drums (brushes + ride)']];
let snd = { muted: false, volume: 40, enabled: { activity: true, done: true, input: true, error: true, alert: true, session: true, drums: true } };
try {
  const raw = JSON.parse(localStorage.getItem(SND_KEY) || 'null');
  if (raw && typeof raw === 'object') {
    if (typeof raw.muted === 'boolean') snd.muted = raw.muted;
    if (Number.isFinite(Number(raw.volume))) snd.volume = Math.max(0, Math.min(100, Math.round(Number(raw.volume))));
    if (raw.enabled && typeof raw.enabled === 'object') for (const [k] of SND_KINDS) if (raw.enabled[k] === false) snd.enabled[k] = false;
  }
} catch {}
function sndSave() { try { localStorage.setItem(SND_KEY, JSON.stringify(snd)); } catch {} }
let sndCtx = null, sndMaster = null, sndBus = null, sndDrumBus = null, sndRhodesBus = null, sndVibesBus = null, sndNoise = null, sndMem = null, sndUnlocked = false, sndTrace = null;
const sndGate = {}, sndGlow = {}, SND_GLOW_MS = 750, SND_CORES = ['claude', 'codex', 'omp', 'gemini'];
// Music state: a shared 72 BPM swung 8th-note clock; everything is scheduled on grid steps.
const sndPending = {}, sndVoices = {}, sndPhrases = [], sndRecent = {};
let sndT0 = 0, sndNext = 0, sndTimer = null, sndWorking = 0;
function sndReduced() { try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } }
// A short, dark room (about half a second) for a little warmth.
function sndImpulse(c) {
  const len = Math.floor(c.sampleRate * 0.5), buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  return buf;
}
// Slow LFO that wobbles an AudioParam (tremolo / vibrato). Guarded: skipped if the API is missing.
function sndLfo(c, rate, depth, param, from, to) {
  try {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = rate; g.gain.value = depth;
    o.connect(g); g.connect(param); o.start(from || 0); if (to) o.stop(to);
  } catch {}
}
function sndEnsure() {
  if (sndCtx) return sndCtx;
  try {
    const AC = (typeof AudioContext !== 'undefined' && AudioContext) || (typeof webkitAudioContext !== 'undefined' && webkitAudioContext);
    if (!AC) return null;
    sndCtx = new AC();
    // voices -> bus -> (dry + short reverb) -> compressor -> warm low-pass -> master volume -> speakers
    const comp = sndCtx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 20; comp.ratio.value = 6; comp.attack.value = 0.008; comp.release.value = 0.3;
    sndMaster = sndCtx.createGain();
    sndBus = sndCtx.createGain();
    const dry = sndCtx.createGain(), wet = sndCtx.createGain(), verb = sndCtx.createConvolver();
    dry.gain.value = 0.85; wet.gain.value = 0.16; verb.buffer = sndImpulse(sndCtx);
    sndBus.connect(dry); dry.connect(comp);
    sndBus.connect(verb); verb.connect(wet); wet.connect(comp);
    sndDrumBus = sndCtx.createGain(); sndDrumBus.gain.value = 0; sndDrumBus.connect(sndBus);
    sndRhodesBus = sndCtx.createGain(); sndRhodesBus.gain.value = 0.85; sndRhodesBus.connect(sndBus);
    sndVibesBus = sndCtx.createGain(); sndVibesBus.gain.value = 0.85; sndVibesBus.connect(sndBus);
    sndLfo(sndCtx, 4.2, 0.12, sndRhodesBus.gain);  // Rhodes: soft tremolo
    sndLfo(sndCtx, 5.0, 0.2, sndVibesBus.gain);    // vibes: motor
    if (typeof sndCtx.createBiquadFilter === 'function') {
      const lp = sndCtx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3800; lp.Q.value = 0.5;
      comp.connect(lp); lp.connect(sndMaster);
    } else comp.connect(sndMaster);
    sndMaster.connect(sndCtx.destination);
    sndLevel(true);
    sndT0 = sndCtx.currentTime + 0.1; sndNext = 0;
    sndTimer = setInterval(sndSchedule, 25);
  } catch { sndCtx = null; }
  return sndCtx;
}
function sndTarget() { return snd.muted ? 0 : Math.pow(snd.volume / 100, 1.5) * 0.7; }
// Smooth ramp (no zipper clicks). The first call, at creation, sets the value outright.
function sndLevel(first) {
  if (!sndMaster) return;
  const g = sndMaster.gain;
  if (first || !sndCtx) { g.value = sndTarget(); return; }
  try { if (g.cancelScheduledValues) g.cancelScheduledValues(sndCtx.currentTime); g.setTargetAtTime(sndTarget(), sndCtx.currentTime, 0.03); } catch { g.value = sndTarget(); }
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
// Fire the glow in time with the note as it actually sounds.
function sndGlowAt(core, when) {
  setTimeout(() => sndPulse(core), Math.max(0, (when - sndCtx.currentTime) * 1000));
}
function sndPlay(p, step, when, full) {
  const cap = musNoteLen(step, sndT0, p.beats * musConst().BEAT);
  if (p.core === 'drums') { sndDrums(p, when, full, cap); return; }
  p.notes.forEach(m => {
    SND_INST[p.core](sndHz(m), when, p.vel * full, cap);
    if (sndTrace) sndTrace({ inst: p.core, midi: m, step, when, len: cap, event: !!p.event });
  });
  sndGlowAt(p.glow || p.core, when);
}
// Lookahead scheduler: runs every 25ms, schedules every step that falls in the next 150ms.
function sndSchedule() {
  const c = sndCtx;
  if (!c) return;
  const horizon = c.currentTime + 0.15;
  const live = c.state === 'running' && !snd.muted && snd.volume > 0;
  const drums = live && snd.enabled.drums && sndWorking > 0;
  if (sndDrumBus) sndDrumBus.gain.setTargetAtTime(drums ? 1 : 0, c.currentTime, 0.8);
  const due = musNextStep(c.currentTime, sndT0);
  if (sndNext < due - 8) sndNext = due; // tab was asleep: skip ahead instead of bursting
  while (musStepTime(sndNext, sndT0) < horizon) {
    const step = sndNext++, when = musStepTime(step, sndT0);
    if (!live) { sndPhrases.length = 0; for (const k of SND_CORES) sndPending[k] = 0; continue; }
    if (when < c.currentTime - 0.02) continue;
    const full = musFullness(sndWorking);
    musStepPlan(sndPending, sndVoices, step, sndPhrases, { drums }).forEach(p => sndPlay(p, step, when, full));
  }
}
// Queue an event motif on the grid, on a beat. Pitches are chosen later, from the chord sounding at that step.
function sndQueuePhrase(ev) {
  const core = SND_CORES.includes(ev.core) ? ev.core : 'claude';
  const start = musPhraseStart(ev.type, Math.max(sndNext, musNextStep(sndCtx.currentTime, sndT0)));
  musPhrase(ev.type, start, core).forEach(n => sndPhrases.push(n));
}
// Visual razzmatazz: a quick glow on the core that made the sound. The map SVG is re-rendered
// every poll, so the glow is re-applied (with the remaining time) after each render.
function sndApplyGlow() {
  if (sndReduced()) return;
  const now = Date.now();
  let cores;
  try { cores = document.querySelectorAll('#map .provider-core'); } catch { return; }
  SND_CORES.forEach((core, i) => {
    const el = cores[i], t = sndGlow[core];
    if (!el || !el.style || t === undefined) return;
    const age = now - t;
    if (age >= SND_GLOW_MS) { delete sndGlow[core]; el.style.animation = ''; return; }
    el.style.animation = 'sndglow ' + SND_GLOW_MS + 'ms ease-out ' + (-age) + 'ms 1 both';
  });
}
function sndPulse(core) { if (sndReduced()) return; sndGlow[core] = Date.now(); sndApplyGlow(); }
// Called with each fresh /state payload.
function soundTick(state) {
  const now = Date.now(), r = soundEvents(sndMem, state, now);
  sndMem = r.mem;
  const c = sndEnsure();
  // Agents working = cores with a running session or activity in the last 8s.
  r.events.forEach(ev => { if (ev.type === 'activity') sndRecent[ev.core] = now; });
  sndWorking = SND_CORES.filter(k => (r.mem.running[k] || 0) > 0 || now - (sndRecent[k] || 0) < 8000).length;
  if (!c || snd.muted || snd.volume <= 0 || c.state !== 'running') return;
  const rest = [];
  r.events.forEach(ev => {
    if (ev.type !== 'activity') rest.push(ev);
    else if (snd.enabled.activity !== false) sndPending[ev.core] = (sndPending[ev.core] || 0) + 1; // merged into velocity at the next step
  });
  planSounds(rest, sndGate, now, snd.enabled).forEach((ev, i) => { if (i < 3) sndQueuePhrase(ev); });
}
function soundReset() { sndMem = null; }
function sndRender() {
  const q = s => document.querySelector(s);
  const t = q('#snd-toggle'), v = q('#snd-vol'), hint = q('#snd-hint');
  if (t) { t.textContent = snd.muted ? '♪ MUTED' : '♪ ON'; t.setAttribute('aria-pressed', String(!snd.muted)); t.classList.toggle('muted', snd.muted); }
  if (v && v.value !== String(snd.volume)) v.value = String(snd.volume);
  const pct = q('#snd-pct');
  if (pct) pct.textContent = snd.volume + '%';
  if (hint) hint.hidden = sndUnlocked || snd.muted;
}
function sndSet(patch) { Object.assign(snd, patch); sndSave(); sndLevel(); sndRender(); }
function sndUnlock() {
  const c = sndEnsure();
  if (c && c.state === 'suspended') { try { c.resume(); } catch {} }
  if (c) { sndUnlocked = true; sndRender(); }
}
function sndBind() {
  const q = s => document.querySelector(s);
  const t = q('#snd-toggle'), v = q('#snd-vol'), mb = q('#snd-menu-btn'), menu = q('#snd-menu');
  if (menu && menu.innerHTML !== undefined) {
    menu.innerHTML = SND_KINDS.map(([k, label]) => '<label><input type="checkbox" data-snd="' + k + '"' + (snd.enabled[k] ? ' checked' : '') + '> ' + label + '</label>').join('');
    menu.addEventListener('change', e => { const k = e.target && e.target.dataset && e.target.dataset.snd; if (k) { snd.enabled[k] = !!e.target.checked; sndSave(); } });
  }
  if (t) t.addEventListener('click', () => { sndUnlock(); sndSet({ muted: !snd.muted }); });
  // Read the slider BEFORE sndUnlock(): unlock re-renders the controls and would reset the slider to the old volume.
  if (v) { const onVol = () => { const vol = Math.max(0, Math.min(100, Math.round(Number(v.value) || 0))); sndUnlock(); sndSet({ volume: vol }); }; v.addEventListener('input', onVol); v.addEventListener('change', onVol); }
  if (mb && menu) mb.addEventListener('click', () => { menu.hidden = !menu.hidden; mb.setAttribute('aria-expanded', String(!menu.hidden)); });
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', sndUnlock, { once: true });
    document.addEventListener('keydown', e => {
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
        if (tag === 'TEXTAREA') return;
        sndUnlock(); sndSet({ muted: !snd.muted });
      } else sndUnlock();
    });
  }
  sndRender();
}
sndBind();
