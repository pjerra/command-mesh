// Browser-side sound engine. Injected into the dashboard page after lib/sound-core.js.
// Everything is synthesized with Web Audio; no audio files. Guarded so missing APIs never throw.
const SND_KEY = 'command-mesh-sound';
const SND_KINDS = [['activity', 'Activity blips'], ['done', 'Agent done'], ['input', 'Needs input'], ['error', 'Errors'], ['alert', 'Limit alerts'], ['session', 'New session'], ['pad', 'Ambient pad']];
let snd = { muted: false, volume: 40, enabled: { activity: true, done: true, input: true, error: true, alert: true, session: true, pad: true } };
try {
  const raw = JSON.parse(localStorage.getItem(SND_KEY) || 'null');
  if (raw && typeof raw === 'object') {
    if (typeof raw.muted === 'boolean') snd.muted = raw.muted;
    if (Number.isFinite(Number(raw.volume))) snd.volume = Math.max(0, Math.min(100, Math.round(Number(raw.volume))));
    if (raw.enabled && typeof raw.enabled === 'object') for (const [k] of SND_KINDS) if (raw.enabled[k] === false) snd.enabled[k] = false;
  }
} catch {}
function sndSave() { try { localStorage.setItem(SND_KEY, JSON.stringify(snd)); } catch {} }
let sndCtx = null, sndMaster = null, sndBus = null, sndPadBus = null, sndMem = null, sndUnlocked = false;
const sndGate = {}, sndGlow = {}, SND_GLOW_MS = 750, SND_CORES = ['claude', 'codex', 'omp', 'gemini'];
// Music state: a shared 96 BPM sixteenth-note clock; everything is scheduled on grid steps.
const sndPending = {}, sndVoices = {}, sndPhrases = [], sndRecent = {};
let sndT0 = 0, sndNext = 0, sndTimer = null, sndWorking = 0, sndPadSpan = -1;
function sndReduced() { try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } }
function sndImpulse(c) {
  const len = Math.floor(c.sampleRate * 1.8), buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
  return buf;
}
function sndEnsure() {
  if (sndCtx) return sndCtx;
  try {
    const AC = (typeof AudioContext !== 'undefined' && AudioContext) || (typeof webkitAudioContext !== 'undefined' && webkitAudioContext);
    if (!AC) return null;
    sndCtx = new AC();
    // voices -> bus -> (dry + short reverb) -> compressor/limiter -> master volume -> speakers
    const comp = sndCtx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 18; comp.ratio.value = 12; comp.attack.value = 0.004; comp.release.value = 0.25;
    sndMaster = sndCtx.createGain();
    sndBus = sndCtx.createGain();
    const dry = sndCtx.createGain(), wet = sndCtx.createGain(), verb = sndCtx.createConvolver();
    dry.gain.value = 0.8; wet.gain.value = 0.3; verb.buffer = sndImpulse(sndCtx);
    sndBus.connect(dry); dry.connect(comp);
    sndBus.connect(verb); verb.connect(wet); wet.connect(comp);
    sndPadBus = sndCtx.createGain(); sndPadBus.gain.value = 0; sndPadBus.connect(sndBus);
    comp.connect(sndMaster); sndMaster.connect(sndCtx.destination);
    sndLevel();
    sndT0 = sndCtx.currentTime + 0.1; sndNext = 0;
    sndTimer = setInterval(sndSchedule, 25);
  } catch { sndCtx = null; }
  return sndCtx;
}
function sndLevel() { if (sndMaster) sndMaster.gain.value = snd.muted ? 0 : Math.pow(snd.volume / 100, 1.5) * 0.7; }
function sndHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
// One partial: absolute start time t, length, peak gain, attack, optional destination.
function sndTone(f, t, len, type, peak, att, dest) {
  const c = sndCtx, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + att);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g); g.connect(dest || sndBus); o.start(t); o.stop(t + len + 0.05);
}
// Instruments: claude = electric piano, codex = plucky bass, omp = marimba, gemini = bell.
const SND_INST = {
  claude: (f, t, v) => { sndTone(f, t, 1.1, 'sine', 0.13 * v, 0.012); sndTone(f * 2, t, 0.5, 'sine', 0.035 * v, 0.008); sndTone(f * 1.003, t, 0.9, 'triangle', 0.04 * v, 0.02); },
  codex: (f, t, v) => { sndTone(f, t, 0.4, 'triangle', 0.3 * v, 0.006); sndTone(f * 2, t, 0.15, 'sine', 0.08 * v, 0.004); },
  omp: (f, t, v) => { sndTone(f, t, 0.24, 'sine', 0.17 * v, 0.004); sndTone(f * 4, t, 0.07, 'sine', 0.05 * v, 0.003); },
  gemini: (f, t, v) => { sndTone(f, t, 1.2, 'sine', 0.1 * v, 0.004); sndTone(f * 2.76, t, 0.5, 'sine', 0.025 * v, 0.003); sndTone(f * 5.4, t, 0.15, 'sine', 0.012 * v, 0.003); }
};
// Fire the glow in time with the note as it actually sounds.
function sndGlowAt(core, when) {
  setTimeout(() => sndPulse(core), Math.max(0, (when - sndCtx.currentTime) * 1000));
}
// Soft ambient pad on the current chord, for the rest of that chord's span.
function sndPad(span, step) {
  const S = 60 / 96 / 4, left = (span + 1) * 32 - step, len = left * S + 0.6, t = sndT0 + step * S;
  const pool = musPool('claude', span % 4, false).filter(m => m >= 48 && m < 72), amp = 0.03 * (0.6 + 0.2 * sndWorking);
  pool.slice(0, 4).forEach(m => {
    sndTone(sndHz(m), t, len, 'sine', amp, Math.min(1.5, len / 3), sndPadBus);
    sndTone(sndHz(m) * 1.004, t, len, 'triangle', amp * 0.5, Math.min(1.5, len / 3), sndPadBus);
  });
}
// Lookahead scheduler: runs every 25ms, schedules every grid step that falls in the next 120ms.
function sndSchedule() {
  const c = sndCtx;
  if (!c) return;
  const S = 60 / 96 / 4, horizon = c.currentTime + 0.12;
  const live = c.state === 'running' && !snd.muted && snd.volume > 0;
  if (sndPadBus) sndPadBus.gain.setTargetAtTime(live && snd.enabled.pad && sndWorking > 0 ? 1 : 0, c.currentTime, 1.0);
  const due = musNextStep(c.currentTime, sndT0);
  if (sndNext < due - 8) sndNext = due; // tab was asleep: skip ahead instead of bursting
  while (sndT0 + sndNext * S < horizon) {
    const step = sndNext++, when = sndT0 + step * S;
    if (!live) { sndPhrases.length = 0; for (const k of SND_CORES) sndPending[k] = 0; continue; }
    if (when < c.currentTime - 0.02) continue;
    const full = musFullness(sndWorking);
    musStepPlan(sndPending, sndVoices, step).forEach(p => {
      p.notes.forEach(m => SND_INST[p.core](sndHz(m), when, p.vel * full));
      sndGlowAt(p.core, when);
    });
    for (let i = sndPhrases.length - 1; i >= 0; i--) {
      const ph = sndPhrases[i];
      if (ph.step > step) continue;
      sndPhrases.splice(i, 1);
      if (ph.step < step) continue;
      if (ph.type === 'error') sndTone(sndHz(ph.midi), when, 0.45, 'sine', 0.2, 0.02);
      else (SND_INST[ph.core] || SND_INST.gemini)(sndHz(ph.midi), when, 0.8);
      sndGlowAt(ph.core, when);
    }
    const span = Math.floor(step / 32);
    if (snd.enabled.pad && sndWorking > 0 && sndPadSpan !== span) { sndPadSpan = span; sndPad(span, step); }
  }
}
// Queue an event phrase on the grid (absolute steps on the shared clock).
function sndQueuePhrase(ev) {
  const core = SND_CORES.includes(ev.core) ? ev.core : 'claude';
  const start = musPhraseStart(ev.type, Math.max(sndNext, musNextStep(sndCtx.currentTime, sndT0)));
  musPhrase(ev.type, start).forEach(n => sndPhrases.push({ step: n.step, midi: n.midi, len: n.len, core, type: ev.type }));
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
  if (v) { v.value = String(snd.volume); }
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
  if (v) v.addEventListener('input', () => { sndUnlock(); sndSet({ volume: Math.max(0, Math.min(100, Number(v.value) || 0)) }); });
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
