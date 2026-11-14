const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { page } = require('../lib/page');

// Tiny fake DOM + Web Audio, enough to run lib/sound-ui.client.js and drive the volume slider.
function harness(stored) {
  const store = stored ? { 'command-mesh-sound': JSON.stringify(stored) } : {};
  const listeners = {};
  const mk = (id, extra) => ({ id, value: '40', textContent: '', hidden: false, dataset: {}, classList: { toggle() {} }, setAttribute() {},
    addEventListener(t, f) { (listeners[id + ':' + t] = listeners[id + ':' + t] || []).push(f); }, ...extra });
  const els = { '#snd-toggle': mk('toggle'), '#snd-vol': mk('vol'), '#snd-pct': mk('pct'), '#snd-hint': mk('hint'), '#snd-menu-btn': mk('mb'), '#snd-menu': mk('menu', { innerHTML: '' }) };
  const gains = [];
  const param = () => ({ value: 0, calls: [], setTargetAtTime(v, t, k) { this.calls.push(['target', v]); this.value = v; }, cancelScheduledValues() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() {}, gain: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  class AC {
    constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
    createGain() { const g = node(); gains.push(g); return g; }
    createDynamicsCompressor() { return node(); }
    createConvolver() { return node(); }
    createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
    resume() {}
  }
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Float32Array, Date, setInterval: () => 0, setTimeout: () => 0,
    AudioContext: AC,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { querySelector: s => els[s] || null, querySelectorAll: () => [], addEventListener() {} },
  };
  vm.createContext(ctx);
  const core = require('../lib/sound-core').source;
  vm.runInContext(core + '\n' + fs.readFileSync(path.join(__dirname, '../lib/sound-ui.client.js'), 'utf8'), ctx);
  const slide = v => { els['#snd-vol'].value = String(v); (listeners['vol:input'] || []).forEach(f => f({})); };
  return { els, gains, store, slide, ctx, saved: () => JSON.parse(store['command-mesh-sound']) };
}
const expected = v => Math.pow(v / 100, 1.5) * 0.7;

test('volume: input event moves the master gain and the slider keeps the new value', () => {
  const h = harness();
  h.slide(80);
  const nodes = h.gains.length;
  assert.strictEqual(h.els['#snd-vol'].value, '80', 'slider must not snap back to the old volume');
  const master = h.gains[0];
  assert.ok(Math.abs(master.gain.value - expected(80)) < 1e-9);
  assert.ok(master.gain.calls.some(c => c[0] === 'target' && Math.abs(c[1] - expected(80)) < 1e-9), 'uses setTargetAtTime ramp');
  h.slide(10);
  assert.ok(Math.abs(master.gain.value - expected(10)) < 1e-9);
  assert.strictEqual(h.gains.length, nodes, 'no gain nodes are recreated while sliding');
});

test('volume: percent label updates and value persists to localStorage', () => {
  const h = harness();
  h.slide(65);
  assert.strictEqual(h.els['#snd-pct'].textContent, '65%');
  assert.strictEqual(h.saved().volume, 65);
});

test('volume: stored value is restored on load', () => {
  const h = harness({ muted: false, volume: 22 });
  assert.strictEqual(h.els['#snd-vol'].value, '22');
  assert.strictEqual(h.els['#snd-pct'].textContent, '22%');
});

test('volume: page markup has the slider and the percent label', () => {
  const html = page('');
  assert.ok(html.includes('id="snd-vol"') && html.includes('id="snd-pct"'));
});
