// Browser-side sound engine. Injected into the dashboard page after lib/sound-core.js.
// Everything is synthesized with Web Audio; no audio files. Guarded so missing APIs never throw.
const SND_KEY = 'command-mesh-sound';
const SND_KINDS = [['activity', 'Activity blips'], ['done', 'Agent done'], ['input', 'Needs input'], ['error', 'Errors'], ['alert', 'Limit alerts'], ['session', 'New session']];
let snd = { muted: false, volume: 40, enabled: { activity: true, done: true, input: true, error: true, alert: true, session: true } };
try {
  const raw = JSON.parse(localStorage.getItem(SND_KEY) || 'null');
  if (raw && typeof raw === 'object') {
    if (typeof raw.muted === 'boolean') snd.muted = raw.muted;
    if (Number.isFinite(Number(raw.volume))) snd.volume = Math.max(0, Math.min(100, Math.round(Number(raw.volume))));
    if (raw.enabled && typeof raw.enabled === 'object') for (const [k] of SND_KINDS) if (raw.enabled[k] === false) snd.enabled[k] = false;
  }
} catch {}
function sndSave() { try { localStorage.setItem(SND_KEY, JSON.stringify(snd)); } catch {} }
let sndCtx = null, sndMaster = null, sndMem = null, sndUnlocked = false;
const sndGate = {}, sndGlow = {}, SND_GLOW_MS = 750, SND_CORES = ['claude', 'codex', 'omp', 'gemini'];
function sndReduced() { try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } }
function sndEnsure() {
  if (sndCtx) return sndCtx;
  try {
    const AC = (typeof AudioContext !== 'undefined' && AudioContext) || (typeof webkitAudioContext !== 'undefined' && webkitAudioContext);
    if (!AC) return null;
    sndCtx = new AC();
    const comp = sndCtx.createDynamicsCompressor();
    sndMaster = sndCtx.createGain();
    sndMaster.connect(comp); comp.connect(sndCtx.destination);
    sndLevel();
  } catch { sndCtx = null; }
  return sndCtx;
}
function sndLevel() { if (sndMaster) sndMaster.gain.value = snd.muted ? 0 : Math.pow(snd.volume / 100, 1.5) * 0.6; }
// One synthesized note: type, start freq, optional glide target, start offset, length, peak gain.
function sndTone(f0, t0, len, type, peak, f1) {
  const c = sndCtx, t = c.currentTime + t0, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.8);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g); g.connect(sndMaster); o.start(t); o.stop(t + len + 0.03);
}
// Each core has its own voice: claude warm, codex crisp, omp bubbly, gemini sparkly.
const SND_VOICE = {
  claude: (f, t, l, p) => { sndTone(f * 0.5, t, l * 1.3, 'sine', p); sndTone(f, t, l, 'triangle', p * 0.6); },
  codex: (f, t, l, p) => { sndTone(f * 1.5, t, l * 0.6, 'square', p * 0.35); sndTone(f * 3, t, l * 0.3, 'triangle', p * 0.25); },
  omp: (f, t, l, p) => { sndTone(f * 0.8, t, l, 'sine', p, f * 1.7); },
  gemini: (f, t, l, p) => { sndTone(f * 2, t, l, 'sine', p * 0.6); sndTone(f * 3.01, t + 0.035, l * 0.8, 'sine', p * 0.4); }
};
const SND_BASE = { claude: 330, codex: 440, omp: 392, gemini: 523 };
const SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
function sndPlay(ev) {
  const c = sndEnsure();
  if (!c || snd.muted || snd.volume <= 0 || c.state !== 'running') return;
  const core = SND_CORES.includes(ev.core) ? ev.core : 'claude', voice = SND_VOICE[core], base = SND_BASE[core];
  if (ev.type === 'activity') voice(base * 1.5, 0, 0.09, 0.22);
  else if (ev.type === 'done') [0, 2, 3, 5].forEach((s, i) => voice(base * SCALE[s], i * 0.085, 0.22, 0.3));
  else if (ev.type === 'input') { sndTone(784, 0, 0.5, 'sine', 0.28); sndTone(784 * 0.75, 0.28, 0.7, 'sine', 0.26); }
  else if (ev.type === 'error') sndTone(150, 0, 0.42, 'sine', 0.4, 70);
  else if (ev.type === 'alert') { [880, 1175, 1568].forEach((f, i) => sndTone(f, i * 0.11, 0.35, 'triangle', 0.2)); }
  else if (ev.type === 'session') {
    sndTone(260, 0, 0.45, 'sawtooth', 0.05, 1900);
    [1568, 2093, 2637].forEach((f, i) => sndTone(f, 0.12 + i * 0.07, 0.22, 'sine', 0.12));
  }
  sndPulse(core);
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
  const out = planSounds(r.events, sndGate, now, snd.enabled);
  out.forEach((ev, i) => { if (i < 3) sndPlay(ev); });
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
