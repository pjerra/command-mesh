const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../mesh');

test('server: /state returns state and svg, / returns html, /nope is 404', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-home-'));
  const handle = start({ port: 0, home, timers: false });
  await handle.ready;
  const { server, port, close } = handle;
  try {
    const base = `http://127.0.0.1:${port}`;
    const stateRes = await fetch(base + '/state');
    assert.strictEqual(stateRes.status, 200);
    assert.strictEqual(stateRes.headers.get('cache-control'), 'no-store');
    const body = await stateRes.json();
    assert.ok(body.state && Array.isArray(body.state.entries));
    assert.ok(typeof body.svg === 'string' && body.svg.includes('<svg'));
    const pageRes = await fetch(base + '/');
    assert.strictEqual(pageRes.status, 200);
    const html = await pageRes.text();
    assert.ok(html.includes('Command Mesh'));
    const missing = await fetch(base + '/nope');
    assert.strictEqual(missing.status, 404);
  } finally {
    await close();
    server.unref?.();
  }
});

test('server: /state carries usage.periods and the period param selects the period', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const NOW = new Date(2026, 10, 12, 15, 30, 0, 0).getTime();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-history-'));
  const dir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const line = (when, id, input, output) => JSON.stringify({
    type: 'assistant',
    cwd: '/home/user/demo',
    sessionId: 's1',
    timestamp: new Date(when).toISOString(),
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'SECRET-TEXT reply text' }],
    },
  });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), [
    line(NOW - 60 * 60e3, 'today-msg', 1000, 100),
    line(NOW - 2 * 24 * 60 * 60e3, 'week-msg', 2000, 200),
  ].join('\n') + '\n');

  const handle = start({ port: 0, home, timers: false, noLimits: true, now: () => NOW });
  await handle.ready;
  await handle.collector.ready;
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const today = await (await fetch(base + '/state')).json();
    assert.ok(!JSON.stringify(today).includes('SECRET-TEXT'), 'no reply text reaches /state');
    assert.ok(today.state.usage && today.state.usage.periods, 'usage.periods is on the state');
    for (const period of ['hour', 'today', 'week', 'month']) {
      assert.ok(today.state.usage.periods[period], `${period} period exists`);
      assert.ok(today.state.usage.periods[period].bars.length > 0, `${period} has bars`);
    }
    assert.strictEqual(today.state.usage.period, 'today', 'the default period is today');
    assert.ok(!/EST \$| tok</.test(today.svg), 'the cores carry no cost pill');

    const week = await (await fetch(base + '/state?period=week')).json();
    assert.strictEqual(week.state.usage.period, 'week');

    const bad = await (await fetch(base + '/state?period=nope')).json();
    assert.strictEqual(bad.state.usage.period, 'today', 'an unknown period falls back to today');
  } finally {
    await handle.close();
    handle.server.unref?.();
  }
});

test('server: /state?range=8h returns 32 bars; the default is 30m', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-activity-server-'));
  const handle = start({ port: 0, home, timers: false, noLimits: true, noHistory: true });
  await handle.ready;
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const eight = await (await fetch(base + '/state?range=8h')).json();
    assert.strictEqual(eight.state.activity.range, '8h');
    assert.strictEqual(eight.state.activity.bars.length, 32);
    const from = eight.state.activity.bars[0].from;
    const to = eight.state.activity.bars[31].to;
    assert.strictEqual(to - from, 32 * 15 * 60e3);
    const def = await (await fetch(base + '/state')).json();
    assert.strictEqual(def.state.activity.range, '30m');
    assert.strictEqual(def.state.activity.bars.length, 30);
    const bad = await (await fetch(base + '/state?range=nope')).json();
    assert.strictEqual(bad.state.activity.range, '30m');
  } finally {
    await handle.close();
    handle.server.unref?.();
  }
});
