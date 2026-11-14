// Browser-side sound shell. Injected into the dashboard page after lib/sound-core.js; the themes in
// lib/sound-themes/*.client.js are injected after this file (see lib/sound-client.js).
// Shared here: master volume, mute, M key, per-event checkboxes, throttle, glow, click-to-enable,
// reduced motion, the theme picker. A theme only decides what the sounds are. Everything is synthesized
// with Web Audio; no audio files. Guarded so missing APIs never throw.
//
// A theme is registered with sndRegister({...}) and must provide:
//   id, name                       short id (saved in localStorage) and menu label
//   onActivity(core, velocity)     one tool call (velocity 1 = a single event)
//   onDone(core)  onNeedsInput(core)  onError(core)  onNewSession(core)  onAlert(core)
//   start()  stop()                build / tear down; stop() must silence everything it scheduled
// Optional: order (menu order), mergesActivity (skip the shared blip throttle; the theme merges bursts
// itself), drums (show the drums checkbox), tempo {min,max}, setTempo(bpm).
// Inside a theme, play through sndOut (a gain node owned by the shell) and call sndPulse(core) or
// sndGlowAt(core, when) for the glow.
const SND_KEY = 'command-mesh-sound';
const SND_KINDS = [['activity', 'Activity blips'], ['done', 'Agent done'], ['input', 'Needs input'], ['error', 'Errors'], ['alert', 'Limit alerts'], ['session', 'New session']];
const SND_THEMES = {}, SND_REQUIRED = ['onActivity', 'onDone', 'onNeedsInput', 'onError', 'onAlert', 'onNewSession', 'start', 'stop'];
let snd = { muted: false, volume: 40, theme: 'classic', tempo: 92, enabled: { activity: true, done: true, input: true, error: true, alert: true, session: true, drums: true } };
try {
  const raw = JSON.parse(localStorage.getItem(SND_KEY) || 'null');
  if (raw && typeof raw === 'object') {
    if (typeof raw.muted === 'boolean') snd.muted = raw.muted;
    if (Number.isFinite(Number(raw.volume))) snd.volume = Math.max(0, Math.min(100, Math.round(Number(raw.volume))));
    if (typeof raw.theme === 'string') snd.theme = raw.theme;
    if (raw.tempo !== undefined) snd.tempo = musClampBpm(raw.tempo);
    if (raw.enabled && typeof raw.enabled === 'object') for (const k of Object.keys(snd.enabled)) if (raw.enabled[k] === false) snd.enabled[k] = false;
  }
} catch {}
function sndSave() { try { localStorage.setItem(SND_KEY, JSON.stringify(snd)); } catch {} }
let sndCtx = null, sndMaster = null, sndOut = null, sndActive = null, sndMem = null, sndUnlocked = false, sndTrace = null, sndWorking = 0;
const sndGate = {}, sndGlow = {}, sndRecent = {}, SND_GLOW_MS = 750, SND_CORES = ['claude', 'codex', 'omp', 'gemini'];
function sndRegister(theme) {
  if (!theme || typeof theme.id !== 'string' || typeof theme.name !== 'string') return false;
  for (const f of SND_REQUIRED) if (typeof theme[f] !== 'function') return false;
  SND_THEMES[theme.id] = theme;
  return true;
}
function sndThemeList() {
  return Object.keys(SND_THEMES).map(k => SND_THEMES[k]).sort((a, b) => (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1));
}
function sndTheme() { return SND_THEMES[snd.theme] || SND_THEMES.classic || sndThemeList()[0] || null; }
function sndReduced() { try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } }
function sndEnsure() {
  if (sndCtx) return sndCtx;
  try {
    const AC = (typeof AudioContext !== 'undefined' && AudioContext) || (typeof webkitAudioContext !== 'undefined' && webkitAudioContext);
    if (!AC) return null;
    sndCtx = new AC();
    sndMaster = sndCtx.createGain();
    sndMaster.connect(sndCtx.destination);
    sndLevel(true);
    sndStartTheme();
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
// Each theme plays into its own gain node, so a switch can silence the old theme at once.
function sndStartTheme() {
  const th = sndTheme();
  if (!sndCtx || !th || sndActive) return;
  sndOut = sndCtx.createGain();
  sndOut.connect(sndMaster);
  sndActive = th;
  try { th.start(); } catch {}
}
function sndStopTheme() {
  if (!sndActive) return;
  const th = sndActive, out = sndOut;
  sndActive = null; sndOut = null;
  try { th.stop(); } catch {}
  // Notes already handed to Web Audio cannot be cancelled one by one: fade their output to silence, then drop it.
  try { if (out.gain.cancelScheduledValues) out.gain.cancelScheduledValues(sndCtx.currentTime); out.gain.setTargetAtTime(0, sndCtx.currentTime, 0.015); } catch { try { out.gain.value = 0; } catch {} }
  setTimeout(() => { try { out.disconnect(); } catch {} }, 250);
}
function sndSetTheme(id) {
  if (!SND_THEMES[id]) return;
  if (snd.theme !== id) { sndStopTheme(); snd.theme = id; sndSave(); sndStartTheme(); }
  sndRenderMenu();
}
function sndSetTempo(bpm) {
  snd.tempo = musClampBpm(bpm);
  sndSave();
  const th = sndActive;
  if (th && typeof th.setTempo === 'function') { try { th.setTempo(snd.tempo); } catch {} }
  const lab = typeof document !== 'undefined' && document.querySelector ? document.querySelector('#snd-tempo-pct') : null;
  if (lab) lab.textContent = snd.tempo + ' BPM';
}
// Fire the glow in time with the note as it actually sounds.
function sndGlowAt(core, when) {
  setTimeout(() => sndPulse(core), Math.max(0, (when - sndCtx.currentTime) * 1000));
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
function sndDispatch(ev, th) {
  const core = SND_CORES.includes(ev.core) ? ev.core : 'claude';
  if (ev.type === 'activity') th.onActivity(core, 1);
  else if (ev.type === 'done') th.onDone(core);
  else if (ev.type === 'input') th.onNeedsInput(core);
  else if (ev.type === 'error') th.onError(core);
  else if (ev.type === 'alert') th.onAlert(core);
  else if (ev.type === 'session') th.onNewSession(core);
}
// Called with each fresh /state payload.
function soundTick(state) {
  const now = Date.now(), r = soundEvents(sndMem, state, now);
  sndMem = r.mem;
  const c = sndEnsure();
  // Agents working = cores with a running session or activity in the last 8s.
  r.events.forEach(ev => { if (ev.type === 'activity') sndRecent[ev.core] = now; });
  sndWorking = SND_CORES.filter(k => (r.mem.running[k] || 0) > 0 || now - (sndRecent[k] || 0) < 8000).length;
  const th = sndActive;
  if (!c || !th || snd.muted || snd.volume <= 0 || c.state !== 'running') return;
  let events = r.events;
  if (th.mergesActivity) { // the theme merges bursts itself: no blip throttle, every event counts
    events = [];
    r.events.forEach(ev => { if (ev.type !== 'activity') events.push(ev); else if (snd.enabled.activity !== false) sndDispatch(ev, th); });
  }
  planSounds(events, sndGate, now, snd.enabled).forEach((ev, i) => { if (i < 3) sndDispatch(ev, th); });
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
// The ▾ menu: theme picker, per-event boxes, then only the controls the current theme has.
function sndRenderMenu() {
  const menu = document.querySelector('#snd-menu');
  if (!menu || menu.innerHTML === undefined) return;
  const th = sndTheme(), cur = th ? th.id : '', box = (k, label) => '<label><input type="checkbox" data-snd="' + k + '"' + (snd.enabled[k] ? ' checked' : '') + '> ' + label + '</label>';
  let h = '<span class="snd-row">Theme</span>' + sndThemeList().map(t => '<label><input type="radio" name="snd-theme" data-snd-theme="' + t.id + '"' + (t.id === cur ? ' checked' : '') + '> ' + t.name + '</label>').join('');
  h += '<span class="snd-sep"></span>' + SND_KINDS.map(([k, label]) => box(k, label)).join('');
  if (th && th.drums) h += box('drums', 'Drums (brushes + ride)');
  if (th && th.tempo) h += '<label class="snd-tempo">Tempo <input type="range" data-snd-tempo min="' + th.tempo.min + '" max="' + th.tempo.max + '" step="1" value="' + snd.tempo + '"> <span id="snd-tempo-pct">' + snd.tempo + ' BPM</span></label>';
  menu.innerHTML = h;
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
  sndRenderMenu();
  if (menu && menu.innerHTML !== undefined) {
    menu.addEventListener('change', e => {
      const d = e.target && e.target.dataset;
      if (!d) return;
      if (d.sndTheme) sndSetTheme(d.sndTheme);
      else if (d.snd) { snd.enabled[d.snd] = !!e.target.checked; sndSave(); }
    });
    menu.addEventListener('input', e => { const d = e.target && e.target.dataset; if (d && d.sndTempo !== undefined) sndSetTempo(e.target.value); });
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
        if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'radio') return;
        if (tag === 'TEXTAREA') return;
        sndUnlock(); sndSet({ muted: !snd.muted });
      } else sndUnlock();
    });
  }
  sndRender();
}
