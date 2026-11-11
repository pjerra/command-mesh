'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createBoard } = require('../lib/board');
const { startDemo } = require('../lib/demo');

const NOW = 1_700_000_000_000;

function runDemo(seed, stepMs = 500, steps = 240) {
  const board = createBoard({ now: () => NOW });
  const demo = startDemo({ board, now: () => NOW, timers: false, seed });
  for (let i = 0; i < steps; i++) demo.step(stepMs);
  demo.dispose();
  return board.snapshot();
}

test('demo: after 2 minutes of steps every station has been used and all three agents have entries', () => {
  const snap = runDemo(7);
  for (const station of ['you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks']) {
    assert.ok(snap.counts[station] > 0, `station ${station} used`);
  }
  for (const provider of ['claude', 'codex', 'omp']) {
    assert.ok(snap.entries.some(e => e.provider === provider), `${provider} has entries`);
    assert.ok(snap.models[provider], `${provider} has a model`);
  }
  assert.deepStrictEqual(snap.presence.claude, true);
  assert.deepStrictEqual(snap.presence.codex, true);
  assert.deepStrictEqual(snap.presence.omp, true);
});

test('demo: same seed gives the same entry sequence', () => {
  const sequence = snap => snap.entries.map(e => [e.id, e.station, e.label, e.status, e.startedAt, e.endedAt]);
  assert.deepStrictEqual(sequence(runDemo(11)), sequence(runDemo(11)));
  assert.notDeepStrictEqual(sequence(runDemo(11)), sequence(runDemo(12)));
});

test('demo: turns close and some tools fail', () => {
  const snap = runDemo(5);
  assert.ok(snap.entries.some(e => e.status === 'err'), 'at least one tool failed');
  assert.ok(snap.entries.some(e => e.station === 'model' && e.status === 'ok'), 'a turn finished');
  const frontier = Math.max(...snap.entries.map(e => e.startedAt));
  for (const entry of snap.entries.filter(e => e.station === 'model')) {
    if (frontier - entry.startedAt > 60e3) assert.notStrictEqual(entry.status, 'run', `${entry.id} still running`);
  }
});

test('demo: limits cover ok, warn, crit and exhausted', () => {
  const board = createBoard({ now: () => NOW });
  const demo = startDemo({ board, now: () => NOW, timers: false, seed: 3 });
  const seen = new Set();
  const notes = [];
  for (let i = 0; i < 240; i++) {
    demo.step(250);
    const limits = board.snapshot().limits;
    for (const source of ['claude', 'codex', 'omp']) {
      for (const account of limits[source].accounts) {
        for (const win of account.windows) {
          const state = win.exhausted ? 'exhausted' : win.usedPercent >= 95 ? 'crit' : win.usedPercent >= 80 ? 'warn' : 'ok';
          seen.add(state);
          if (notes.length < 40) notes.push(`${source}/${account.name}/${win.label}=${win.usedPercent}${win.exhausted ? '!' : ''}`);
        }
      }
    }
  }
  demo.dispose();
  assert.deepStrictEqual([...seen].sort(), ['crit', 'exhausted', 'ok', 'warn'], notes.join(' '));
  const limits = board.snapshot().limits;
  for (const source of ['claude', 'codex', 'omp']) {
    for (const account of limits[source].accounts) {
      for (const win of account.windows) {
        assert.ok(win.resetsAt > NOW, `${source}/${account.name}/${win.label} resets in the future`);
      }
    }
  }
  const go1 = limits.omp.accounts.find(a => a.name === 'OMP go1');
  const month = go1.windows.find(w => w.label === 'Month');
  assert.strictEqual(month.exhausted, true);
  assert.strictEqual(month.usedPercent, 100);
});

test('server: /state?demo=1 serves the demo board, /state stays live, the demo stops after 60 s idle', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { start } = require('../mesh');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-demo-'));
  let clock = NOW;
  const handle = start({ port: 0, home, timers: false, noLimits: true, now: () => clock, demoIdleMs: 60e3 });
  await handle.ready;
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const first = await (await fetch(base + '/state?demo=1')).json();
    assert.strictEqual(first.state.demo, true);
    assert.ok(first.state.entries.length > 0, 'demo has entries immediately');
    assert.ok(first.state.entries.every(e => e.id.startsWith('demo-')), 'demo ids are prefixed');
    assert.ok(handle.demo, 'the started demo is exposed');

    const dir = path.join(home, '.claude', 'projects', 'x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), '');
    const tail = handle.tails.find(t => t.source.provider === 'claude').tail;
    tail.discover();
    fs.appendFileSync(path.join(dir, 's.jsonl'), JSON.stringify({
      type: 'user', uuid: 'live-1', sessionId: 'live-s', cwd: '/home/user/demo',
      timestamp: new Date().toISOString(), message: { content: 'hello there' },
    }) + '\n');
    tail.poll();

    const live = await (await fetch(base + '/state')).json();
    assert.ok(live.state.entries.some(e => e.id === 'claude-you-live-1'), 'live board recorded the line');
    assert.ok(!('demo' in live.state), 'live state has no demo flag');
    assert.ok(live.state.entries.every(e => !e.id.startsWith('demo-')), 'no demo entry in the live board');

    const second = await (await fetch(base + '/state?demo=1')).json();
    assert.ok(!JSON.stringify(second.state).includes('live-1'), 'live activity never reaches the demo');
    assert.ok(second.state.entries.every(e => !e.id.includes('live-')), 'demo board only carries demo ids');

    clock += 61e3;
    await fetch(base + '/state');
    assert.strictEqual(handle.demo, null, 'demo stops after the idle window');
    const third = await (await fetch(base + '/state?demo=1')).json();
    assert.strictEqual(third.state.demo, true);
    assert.ok(third.state.entries.length > 0, 'restarted demo has entries');
    assert.ok(third.state.entries[0].startedAt > first.state.entries[0].startedAt, 'restart is a fresh run');
  } finally {
    await handle.close();
    handle.server.unref?.();
  }
});
