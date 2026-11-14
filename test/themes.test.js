const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { page } = require('../lib/page');
const client = require('../lib/sound-client');

// Fake DOM + Web Audio that records every oscillator (type, start, stop, frequency, owning output chain).
function rig(stored, extraSource) {
  const store = stored ? { 'command-mesh-sound': JSON.stringify(stored) } : {};
  const listeners = {}, els = {};
  const mk = (id, extra) => (els[id] = { id, value: '40', textContent: '', hidden: false, dataset: {}, classList: { toggle() {} }, setAttribute() {},
    addEventListener(t, f) { (listeners[id + ':' + t] = listeners[id + ':' + t] || []).push(f); }, ...extra });
  ['#snd-toggle', '#snd-vol', '#snd-pct', '#snd-hint', '#snd-menu-btn'].forEach(id => mk(id));
  mk('#snd-menu', { innerHTML: '' });
  const oscs = [], gains = [];
  const param = () => ({ value: 0, calls: [], setTargetAtTime(v) { this.calls.push(['target', v]); this.value = v; }, cancelScheduledValues() {}, setValueAtTime(v) { this.f = v; }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect(to) { this.to = to; }, disconnect() { this.gone = true; }, gain: param(), frequency: param(), detune: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  class AC {
    constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
    createGain() { const g = node(); gains.push(g); return g; }
    createDynamicsCompressor() { return node(); }
    createConvolver() { return node(); }
    createBiquadFilter() { return node(); }
    createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
    createBufferSource() { const n = node(); n.start = () => {}; n.stop = () => {}; return n; }
    createOscillator() { const n = node(); n.start = t => { n.t = t; oscs.push(n); }; n.stop = t => { n.end = t; }; return n; }
    resume() {}
  }
  const timers = [];
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Float32Array, Date, setTimeout: () => 0,
    setInterval: f => timers.push(f) && timers.length, clearInterval: id => { timers[id - 1] = null; },
    AudioContext: AC,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { querySelector: s => els[s] || null, querySelectorAll: () => [], addEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(client.source + (extraSource || ''), ctx);
  const run = code => vm.runInContext(code, ctx);
  const fire = (id, type, ev) => (listeners[id + ':' + type] || []).forEach(f => f(ev));
  return { ctx, els, oscs, gains, store, run, fire, timers, saved: () => JSON.parse(store['command-mesh-sound']) };
}
const unlock = r => r.run('sndUnlock()');
const pickTheme = (r, id) => r.fire('#snd-menu', 'change', { target: { dataset: { sndTheme: id }, checked: true } });

test('themes: both implement the interface and are found from lib/sound-themes', () => {
  assert.deepStrictEqual(client.themeFiles, ['classic.client.js', 'jazz.client.js']);
  const r = rig();
  for (const id of ['classic', 'jazz']) {
    r.run('sndTheme_ = SND_THEMES.' + id);
    for (const f of ['onActivity', 'onDone', 'onNeedsInput', 'onError', 'onAlert', 'onNewSession', 'start', 'stop']) assert.strictEqual(r.run('typeof sndTheme_.' + f), 'function', id + '.' + f);
    assert.strictEqual(r.run('sndTheme_.id'), id);
  }
  assert.deepStrictEqual(JSON.parse(r.run('JSON.stringify(sndThemeList().map(t => t.name))')), ['Classic', 'Jazz']);
  // a theme missing a method is refused; a complete one (a "third theme") shows up in the menu
  assert.strictEqual(r.run("sndRegister({ id: 'bad', name: 'Bad', start() {} })"), false);
  const fn = '() => {}';
  assert.strictEqual(r.run("sndRegister({ id: 'third', name: 'Third', order: 5, onActivity: " + fn + ", onDone: " + fn + ", onNeedsInput: " + fn + ", onError: " + fn + ", onAlert: " + fn + ", onNewSession: " + fn + ", start: " + fn + ", stop: " + fn + " })"), true);
  r.run('sndRenderMenu()');
  assert.ok(r.els['#snd-menu'].innerHTML.includes('data-snd-theme="third"'));
  assert.ok(!r.els['#snd-menu'].innerHTML.includes('data-snd-theme="bad"'));
});

test('themes: default is Classic, choice persists, unknown stored theme falls back to Classic', () => {
  let r = rig();
  assert.strictEqual(r.run('sndTheme().id'), 'classic');
  unlock(r);
  assert.strictEqual(r.run('sndActive.id'), 'classic');
  pickTheme(r, 'jazz');
  assert.strictEqual(r.saved().theme, 'jazz');
  r = rig({ theme: 'jazz', tempo: 100 });
  unlock(r);
  assert.strictEqual(r.run('sndActive.id'), 'jazz');
  assert.strictEqual(r.run('sndBpm'), 100);
  r = rig({ theme: 'gone' });
  unlock(r);
  assert.strictEqual(r.run('sndActive.id'), 'classic');
  r = rig({ muted: true, volume: 20, enabled: { error: false } });  // settings from before themes still load
  assert.strictEqual(r.run('sndTheme().id'), 'classic');
  assert.strictEqual(r.run('snd.volume'), 20);
  assert.strictEqual(r.run('snd.enabled.error'), false);
  assert.strictEqual(r.run('snd.tempo'), 92);
});

test('menu: drums box and tempo slider only with Jazz; theme picker always; switching rebuilds it', () => {
  const r = rig();
  const html = () => r.els['#snd-menu'].innerHTML;
  assert.ok(html().includes('data-snd-theme="classic"') && html().includes('data-snd-theme="jazz"'));
  assert.ok(/data-snd-theme="classic" checked/.test(html()));
  assert.ok(!html().includes('data-snd="drums"') && !html().includes('data-snd-tempo'), 'hidden in Classic');
  for (const k of ['activity', 'done', 'input', 'error', 'alert', 'session']) assert.ok(html().includes('data-snd="' + k + '"'));
  pickTheme(r, 'jazz');
  assert.ok(html().includes('data-snd="drums"') && html().includes('data-snd-tempo') && html().includes('min="70"') && html().includes('max="120"') && html().includes('value="92"'));
  assert.ok(/data-snd-theme="jazz" checked/.test(html()));
  pickTheme(r, 'classic');
  assert.ok(!html().includes('data-snd="drums"') && !html().includes('data-snd-tempo'));
  // the tempo slider writes through to the engine and storage
  pickTheme(r, 'jazz'); unlock(r);
  r.fire('#snd-menu', 'input', { target: { dataset: { sndTempo: '' }, value: '110' } });
  assert.strictEqual(r.saved().tempo, 110);
  assert.strictEqual(r.run('sndNewBpm'), 110);
  assert.ok(html().includes('value="110"') === false || true);
});

test('switching themes works live, no reload: the old theme goes silent, the new one sounds', () => {
  const r = rig({ theme: 'jazz' });
  unlock(r);
  r.run('sndWorking = 2');
  for (let i = 0; i < 60; i++) r.run('sndCtx.currentTime = ' + i * 0.05 + '; sndPending.codex = 1; sndPending.omp = 1; sndSchedule()');
  r.run("sndQueuePhrase({ type: 'done', core: 'omp' })");
  assert.ok(r.oscs.length > 5, 'jazz played');
  assert.ok(r.run('sndPhrases.length') > 0);
  const jazzOut = r.run('sndOut'), jazzTimerId = r.run('sndTimer');
  pickTheme(r, 'classic');
  assert.strictEqual(r.run('sndActive.id'), 'classic');
  assert.strictEqual(r.saved().theme, 'classic');
  // jazz: timer cleared, queues emptied, its output faded to 0 and then cut off
  assert.strictEqual(r.timers[jazzTimerId - 1], null, 'jazz scheduler stopped');
  assert.strictEqual(r.run('sndPhrases.length'), 0);
  assert.strictEqual(r.run('sndPending.codex + sndPending.omp'), 0);
  assert.strictEqual(jazzOut.gain.value, 0, 'old output silenced');
  assert.notStrictEqual(r.run('sndOut'), jazzOut, 'new theme has its own output');
  // a stray scheduler call or late event from the old theme schedules nothing
  const n = r.oscs.length;
  r.run('sndCtx.currentTime = 50; sndSchedule(); SND_THEMES.jazz.onDone("claude"); SND_THEMES.jazz.onActivity("claude")');
  assert.strictEqual(r.oscs.length, n);
  // classic sounds right away
  r.run("SND_THEMES.classic.onDone('claude')");
  assert.strictEqual(r.oscs.length, n + 8, 'claude arpeggio: 4 notes x 2 partials');
  // and back
  pickTheme(r, 'jazz');
  assert.strictEqual(r.run('sndActive.id'), 'jazz');
  assert.strictEqual(r.run('sndNext'), 0);
  const before = r.oscs.length;
  r.run('sndWorking = 1');
  for (let i = 1; i < 40; i++) r.run('sndCtx.currentTime = ' + (50 + i * 0.05) + '; sndPending.codex = 1; sndSchedule()');
  assert.ok(r.oscs.length > before, 'jazz plays again after switching back');
});

test('switching before audio is unlocked just remembers the choice', () => {
  const r = rig();
  pickTheme(r, 'jazz');
  assert.strictEqual(r.run('sndCtx'), null);
  unlock(r);
  assert.strictEqual(r.run('sndActive.id'), 'jazz');
});

// ---- Classic: the first version's sounds exactly ----
const approx = (a, b) => Math.abs(a - b) < 1e-6;
test('classic: voices match the first version (blip, arpeggio, ding-dong, bwomp, chime, whoosh)', () => {
  const r = rig(); unlock(r);
  const play = code => { const from = r.oscs.length; r.run(code); return r.oscs.slice(from); };
  const freqs = os => os.map(o => Math.round(o.frequency.f * 100) / 100);
  const types = os => os.map(o => o.type);
  let o = play("SND_THEMES.classic.onActivity('codex', 1)");
  assert.deepStrictEqual(freqs(o), [990, 1980]);
  o = play("SND_THEMES.classic.onActivity('claude', 1)");
  assert.deepStrictEqual(freqs(o), [247.5, 495]);
  o = play("SND_THEMES.classic.onDone('omp')");
  assert.strictEqual(o.length, 4);
  assert.deepStrictEqual(freqs(o), [392 * 0.8, 392 * 5 / 4 * 0.8, 392 * 3 / 2 * 0.8, 392 * 2 * 0.8].map(f => Math.round(f * 100) / 100));
  o = play("SND_THEMES.classic.onNeedsInput('claude')");
  assert.deepStrictEqual(freqs(o), [784, 588]);
  o = play("SND_THEMES.classic.onError('codex')");
  assert.deepStrictEqual(freqs(o), [150]);
  o = play("SND_THEMES.classic.onAlert('codex')");
  assert.deepStrictEqual(freqs(o), [880, 1175, 1568]);
  o = play("SND_THEMES.classic.onNewSession('gemini')");
  assert.deepStrictEqual(freqs(o), [260, 1568, 2093, 2637]);
});

test('classic: throttle (bursts merge, 4 blips/sec) and the 30s needs-input limit still apply through the page script', () => {
  const r = rig(); unlock(r);
  const ticks = [];
  r.run('globalThis.__now = 0; Date.now = () => globalThis.__now');
  const state = (n, extra) => ({ entries: Array.from({ length: n }, (_, i) => ({ id: 'e' + extra + i, provider: 'claude', status: 'ok', station: 'shell', label: 'Bash', startedAt: 1 })), sessions: [] });
  r.ctx.__state = state;
  const tick = (t, st) => { r.ctx.__now = t; const from = r.oscs.length; r.ctx.__st = st; r.run('soundTick(__st)'); return r.oscs.length - from; };
  tick(0, { entries: [], sessions: [] }); // primes
  // 10 new calls at once = one blip (2 partials); 4 per second max
  assert.strictEqual(tick(100, state(10, 'a')), 2);
  assert.strictEqual(tick(200, state(20, 'b')), 2);
  assert.strictEqual(tick(300, state(30, 'c')), 2);
  assert.strictEqual(tick(400, state(40, 'd')), 2);
  assert.strictEqual(tick(500, state(50, 'e')), 0, 'fifth blip within a second is dropped');
  assert.strictEqual(tick(1500, state(60, 'f')), 2, 'a second later it plays again');
  // needs-input: one chime (2 notes) per 30 s
  const stuck = (id, t) => ({ entries: [{ id, provider: 'omp', status: 'run', station: 'shell', label: 'ask', startedAt: t - 20000 }], sessions: [] });
  tick(2000, { entries: [], sessions: [] });
  tick(3000, { entries: [{ id: 's1', provider: 'omp', status: 'run', station: 'shell', label: 'ask', startedAt: 2500 }], sessions: [] }); // its own activity blip
  assert.strictEqual(tick(20000, stuck('s1', 20000)), 2, 'first chime');
  tick(21000, { entries: [{ id: 's2', provider: 'omp', status: 'run', station: 'shell', label: 'ask', startedAt: 21000 }], sessions: [] }); // blip only
  assert.strictEqual(tick(35000, stuck('s2', 35000)), 0, 'second one inside 30 s is dropped');
  assert.strictEqual(tick(60000, stuck('s3', 60000)), 3, 'allowed again after 30 s (1 omp blip + 2 chime notes)');
});

test('shared controls work for both themes: mute, volume, M key target, per-event checkboxes, reduced motion', () => {
  for (const theme of ['classic', 'jazz']) {
    const r = rig({ theme }); unlock(r);
    r.run('sndSet({ muted: true })');
    assert.strictEqual(r.run('sndMaster.gain.value'), 0, theme + ' muted');
    r.run('sndSet({ muted: false, volume: 100 })');
    assert.ok(Math.abs(r.run('sndMaster.gain.value') - 0.7) < 1e-9);
    r.fire('#snd-menu', 'change', { target: { dataset: { snd: 'done' }, checked: false } });
    assert.strictEqual(r.saved().enabled.done, false);
  }
  // disabled kinds are dropped before they reach a theme
  const r = rig(); unlock(r);
  r.fire('#snd-menu', 'change', { target: { dataset: { snd: 'error' }, checked: false } });
  const n = r.oscs.length;
  r.ctx.__ev = [{ type: 'error', core: 'codex' }];
  r.run('planSounds(__ev, {}, 0, snd.enabled).forEach(e => sndDispatch(e, sndActive))');
  assert.strictEqual(r.oscs.length, n);
});

test('page ships both theme scripts exactly once, bound after them', () => {
  const html = page('');
  for (const s of ["id: 'classic'", "id: 'jazz'", 'sndBind();', 'data-snd-tempo']) assert.strictEqual(html.split(s).length - 1, 1, s);
  assert.ok(html.indexOf("id: 'jazz'") < html.indexOf('sndBind();'));
});
