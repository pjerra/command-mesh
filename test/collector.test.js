'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLedger } = require('../lib/usage/ledger');
const { startCollector } = require('../lib/usage/collector');

const NOW = new Date(2026, 10, 12, 15, 30, 0, 0).getTime();
const USAGE = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const CLAUDE_COST = (1000 * 4 + 100 * 20) / 1e6;

function claudeLine(when, id, extra) {
  return JSON.stringify({
    type: 'assistant',
    cwd: '/home/user/demo',
    sessionId: 'session-demo',
    timestamp: new Date(when).toISOString(),
    message: { id, model: 'claude-opus-5-5', usage: USAGE, content: [{ type: 'text', text: 'reply text' }] },
    ...extra,
  });
}

function ompLine(when, id) {
  return JSON.stringify({
    type: 'message',
    id,
    timestamp: new Date(when).toISOString(),
    message: {
      role: 'assistant',
      model: 'muse-spark',
      usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      content: [{ type: 'text', text: 'reply text' }],
    },
  });
}

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-usage-'));
  const dir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
}

function makeCollector(home, now) {
  const ledger = createLedger({ now: () => now });
  const collector = startCollector({
    ledger,
    home,
    now: () => now,
    timers: false,
    cacheFile: path.join(home, 'cache', 'usage.json'),
  });
  return { ledger, collector };
}

test('collector: back-fill reads only files inside the window, then picks up appended lines live, nothing counted twice', async () => {
  const { home, dir } = setupHome();
  const recent = path.join(dir, 'recent.jsonl');
  fs.writeFileSync(recent, claudeLine(NOW - 10 * 60e3, 'msg-recent') + '\n');
  const old = path.join(dir, 'old.jsonl');
  fs.writeFileSync(old, claudeLine(NOW - 10 * 60e3, 'msg-old') + '\n');
  const oldTime = new Date(NOW - 60 * 24 * 3600e3);
  fs.utimesSync(old, oldTime, oldTime);

  const { ledger, collector } = makeCollector(home, NOW);
  await collector.ready;
  assert.strictEqual(collector.state().loading, false);
  assert.ok(Math.abs(ledger.periods(NOW).today.per.claude.cost - CLAUDE_COST) < 1e-9, 'only the file inside the window counts');

  fs.appendFileSync(recent, claudeLine(NOW - 60e3, 'msg-live') + '\n');
  collector.poll();
  assert.ok(Math.abs(ledger.periods(NOW).today.per.claude.cost - CLAUDE_COST * 2) < 1e-9, 'the appended line is read live');
  collector.poll();
  assert.ok(Math.abs(ledger.periods(NOW).today.per.claude.cost - CLAUDE_COST * 2) < 1e-9, 'a second poll does not count it again');
  collector.close();
});

test('collector: restart from the cache file does not count old lines again', async () => {
  const { home, dir } = setupHome();
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, claudeLine(NOW - 30 * 60e3, 'msg-1') + '\n' + claudeLine(NOW - 20 * 60e3, 'msg-2') + '\n');

  const first = makeCollector(home, NOW);
  await first.collector.ready;
  const before = first.ledger.periods(NOW).today.per.claude;
  assert.ok(Math.abs(before.cost - CLAUDE_COST * 2) < 1e-9);
  first.collector.close();

  const second = makeCollector(home, NOW);
  await second.collector.ready;
  const after = second.ledger.periods(NOW).today.per.claude;
  assert.ok(Math.abs(after.cost - before.cost) < 1e-9, 'the cache offset prevents a second read');
  assert.strictEqual(after.tokens, before.tokens);
  second.collector.close();
});

test('collector: a codex turn priced by the rollout is not priced again from the log', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-usage-codex-'));
  const dir = path.join(home, '.codex', 'sessions', '2026');
  fs.mkdirSync(dir, { recursive: true });
  const when = new Date(NOW - 5 * 60e3).toISOString();
  const turn1 = '00000000-0000-0000-0000-000000000001';
  const turn2 = '00000000-0000-0000-0000-000000000002';
  fs.writeFileSync(path.join(dir, 'rollout.jsonl'), [
    JSON.stringify({ type: 'turn_context', timestamp: when, payload: { turn_id: turn1, model: 'gpt-5' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: when,
      payload: { type: 'token_count', turn_id: turn1, info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } } },
    }),
  ].join('\n') + '\n');

  const rolloutCost = (600 * 1.25 + 400 * 0.125 + 100 * 10) / 1e6;
  const ledger = createLedger({ now: () => NOW });
  const rows = [
    { id: 1, ts: Math.floor(NOW / 1000), thread_id: 'thread-1', usage_part: 'total_usage_tokens=1000', usage_turn: `post sampling turn_id=${turn1}` },
    { id: 2, ts: Math.floor(NOW / 1000), thread_id: 'thread-1', usage_part: 'total_usage_tokens=2000', usage_turn: `post sampling turn_id=${turn2}` },
  ];
  const collector = startCollector({
    ledger,
    home,
    now: () => NOW,
    timers: false,
    cacheFile: path.join(home, 'cache.json'),
    codexRows: () => rows,
  });
  await collector.ready;
  const periods = ledger.periods(NOW);
  const logCost = (1000 * 0.125 + 1000 * 10) / 1e6;
  assert.ok(Math.abs(periods.today.per.codex.cost - (rolloutCost + logCost)) < 1e-12, 'turn-1 is priced once, from the rollout');
  assert.strictEqual(periods.today.per.codex.rough, true, 'the live-log part is still rough');

  collector.poll();
  assert.ok(Math.abs(ledger.periods(NOW).today.per.codex.cost - (rolloutCost + logCost)) < 1e-12, 'a later poll does not reprice the rows');
  collector.close();
});

test('collector: lines without "usage" are never JSON-parsed', async () => {
  const { home, dir } = setupHome();
  fs.writeFileSync(path.join(dir, 'mixed.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: 'NO-USAGE-MARKER prompt text' } }),
    claudeLine(NOW - 60e3, 'msg-usage'),
  ].join('\n') + '\n');

  const original = JSON.parse;
  const parsedLines = [];
  JSON.parse = function spy(text, ...rest) {
    if (typeof text === 'string') parsedLines.push(text);
    return original.call(this, text, ...rest);
  };
  let result;
  try {
    result = makeCollector(home, NOW);
    await result.collector.ready;
  } finally {
    JSON.parse = original;
  }
  assert.ok(parsedLines.some(line => line.includes('"usage"')), 'the usage line is parsed');
  assert.ok(!parsedLines.some(line => line.includes('NO-USAGE-MARKER')), 'the line without usage is skipped before JSON.parse');
  assert.ok(Math.abs(result.ledger.periods(NOW).today.per.claude.cost - CLAUDE_COST) < 1e-9);
  result.collector.close();
});

test('privacy: no prompt text from any log reaches the cache file or the ledger', async () => {
  const { home, dir } = setupHome();
  const when = new Date(NOW - 60e3).toISOString();
  fs.writeFileSync(path.join(dir, 'secret.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: when, cwd: '/home/user/demo', message: { content: 'SECRET-TEXT from the user' } }),
    claudeLine(NOW - 60e3, 'msg-secret', { message: { id: 'msg-secret', model: 'claude-opus-5-5', usage: USAGE, content: [{ type: 'text', text: 'SECRET-TEXT reply' }] } }),
    ompLine(NOW - 30e3, 'omp-secret'),
  ].join('\n') + '\n');

  const { ledger, collector } = makeCollector(home, NOW);
  await collector.ready;
  collector.close();

  const cache = fs.readFileSync(path.join(home, 'cache', 'usage.json'), 'utf8');
  assert.ok(!cache.includes('SECRET-TEXT'), 'the cache file holds counts only');
  collector.poll();
  assert.ok(!JSON.stringify(ledger.periods(NOW)).includes('SECRET-TEXT'), 'the periods sent to the page hold counts only');
});
