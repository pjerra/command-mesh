const { test } = require('node:test');
const assert = require('node:assert');
const { soundEvents, planSounds } = require('../lib/sound-core');
const { page } = require('../lib/page');

const T = 1e6;
const ent = (id, provider, status, extra) => ({ id, provider, status, station: 'shell', label: 'Bash ls', startedAt: T, ...extra });
const types = r => r.events.map(e => e.type + ':' + e.core);

test('sound: first state is silent (primes memory)', () => {
  const r = soundEvents(null, { entries: [ent('a', 'claude', 'ok')], sessions: [{ key: 's1', provider: 'claude' }] }, T);
  assert.deepStrictEqual(r.events, []);
});

test('sound: new tool call = activity for that core, never carries label text', () => {
  const m = soundEvents(null, { entries: [] }, T).mem;
  const r = soundEvents(m, { entries: [ent('a', 'codex', 'ok', { label: 'SECRET prompt' })] }, T);
  assert.deepStrictEqual(r.events, [{ type: 'activity', core: 'codex' }]);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('sound: errors, turn end, new session, idle after work', () => {
  const m = soundEvents(null, { entries: [ent('a', 'omp', 'run')], sessions: [{ key: 's1', provider: 'claude', running: true }] }, T).mem;
  const r = soundEvents(m, {
    entries: [ent('a', 'omp', 'err'), ent('b', 'gemini', 'ok', { label: 'Gemini working' })],
    sessions: [{ key: 's1', provider: 'claude', running: false }, { key: 's2', provider: 'gemini' }],
  }, T);
  assert.deepStrictEqual(types(r).sort(), ['done:claude', 'done:gemini', 'error:omp', 'session:gemini']);
});

test('sound: needs-input fires once for a stuck tool call', () => {
  const state = { entries: [ent('a', 'claude', 'run', { startedAt: T - 20000 })] };
  let m = soundEvents(null, { entries: [ent('a', 'claude', 'run', { startedAt: T - 1000 })] }, T - 19000).mem;
  let r = soundEvents(m, state, T);
  assert.deepStrictEqual(types(r), ['input:claude']);
  r = soundEvents(r.mem, state, T + 1000);
  assert.deepStrictEqual(r.events, []);
});

test('sound: limit alert once per threshold, again only on a higher one', () => {
  const lim = pct => ({ limits: { codex: { accounts: [{ name: 'a', windows: [{ label: '5h', usedPercent: pct, resetsAt: 5 }] }] } } });
  let m = soundEvents(null, lim(10), T).mem;
  let r = soundEvents(m, lim(85), T);
  assert.deepStrictEqual(types(r), ['alert:codex']);
  r = soundEvents(r.mem, lim(86), T);
  assert.deepStrictEqual(r.events, []);
  r = soundEvents(r.mem, lim(96), T);
  assert.deepStrictEqual(types(r), ['alert:codex']);
});

test('sound throttle: bursts merge, max 4 blips/sec', () => {
  const gate = {};
  const burst = Array.from({ length: 10 }, () => ({ type: 'activity', core: 'claude' }));
  assert.strictEqual(planSounds(burst, gate, 0).length, 1);
  for (const t of [100, 200, 300]) assert.strictEqual(planSounds(burst, gate, t).length, 1);
  assert.strictEqual(planSounds(burst, gate, 400).length, 0);
  assert.strictEqual(planSounds(burst, gate, 1001).length, 1);
});

test('sound throttle: input chime at most once per 30s; disabled kinds dropped', () => {
  const gate = {}, inp = [{ type: 'input', core: 'omp' }];
  assert.strictEqual(planSounds(inp, gate, 0).length, 1);
  assert.strictEqual(planSounds(inp, gate, 29999).length, 0);
  assert.strictEqual(planSounds(inp, gate, 30000).length, 1);
  assert.strictEqual(planSounds([{ type: 'error', core: 'claude' }], {}, 0, { error: false }).length, 0);
  const e = [{ type: 'error', core: 'claude' }];
  assert.strictEqual(planSounds(e, gate, 100).length, 1);
  assert.strictEqual(planSounds(e, gate, 600).length, 0);
});

test('sound: page ships controls and engine, no external audio', () => {
  const html = page('');
  for (const id of ['snd-toggle', 'snd-vol', 'snd-menu', 'snd-hint']) assert.ok(html.includes('id="' + id + '"'));
  assert.ok(html.includes('function soundEvents') && html.includes('AudioContext'));
  assert.ok(!/\.(mp3|wav|ogg)|https?:\/\/(?!127)/.test(html.split('<script>')[1]));
});
