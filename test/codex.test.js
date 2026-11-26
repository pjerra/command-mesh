const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createBoard } = require('../lib/board');
const { createSessions } = require('../lib/sessions');
const { createLedger } = require('../lib/usage/ledger');
const { startCollector } = require('../lib/usage/collector');
const { walkJsonl } = require('../lib/tail');
const codex = require('../lib/sources/codex');
const { startLimits } = require('../lib/limits');

let DatabaseSync = null;
try {
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
} catch {
  DatabaseSync = null;
}
const DatabaseSyncMissing = DatabaseSync === null;
const { startCodexLog } = DatabaseSyncMissing ? { startCodexLog: null } : require('../lib/sources/codex-log');

const NOW = Date.parse('2026-11-26T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const ID1 = '11111111-2222-4333-8444-555555555555';
const ID2 = '22222222-3333-4444-8555-666666666666';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-codex-acct-'));
}

// Synthetic rollout: ids, cwd, a turn id and no prompt text.
function seedRollout(dir, id, at = NOW) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-26T10-00-00-${id}.jsonl`);
  const lines = [
    { timestamp: iso(at), type: 'session_meta', payload: { id, cwd: '/work/demo2' } },
    { timestamp: iso(at + 1000), type: 'event_msg', payload: { type: 'task_started', turn_id: `T-${id.slice(0, 4)}` } },
    { timestamp: iso(at + 2000), type: 'event_msg', payload: { type: 'task_complete', turn_id: `T-${id.slice(0, 4)}` } },
  ];
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

test('codex: the second CODEX_HOME is read only when it exists', () => {
  const home = tempHome();
  assert.strictEqual(codex.accountHome(home), null);
  assert.deepStrictEqual(codex.roots(home), [path.join(home, '.codex', 'sessions')]);

  const second = path.join(home, '.codex-acct2');
  const file = seedRollout(path.join(second, 'sessions', '2026', '11', '26'), ID2);
  assert.strictEqual(codex.accountHome(home), second);
  assert.deepStrictEqual(codex.roots(home), [
    path.join(home, '.codex', 'sessions'),
    path.join(second, 'sessions'),
  ]);
  const found = [];
  for (const dir of codex.roots(home)) walkJsonl(dir, 6, found);
  assert.deepStrictEqual(found, [file], 'the second home is tailed, the missing first one is not an error');
});

test('codex: account 2 sessions carry the account in the key and on the row', () => {
  const home = tempHome();
  const secondFile = seedRollout(path.join(home, '.codex-acct2', 'sessions', '2026', '11', '26'), ID2);
  const firstFile = path.join(home, '.codex', 'sessions', '2026', '11', '26', `rollout-2026-11-26T09-00-00-${ID1}.jsonl`);
  const sessions = createSessions({ now: () => NOW });
  const board = createBoard({ now: () => NOW, sessions });
  const ctx = { board, now: () => NOW, only: '' };

  const s2 = { file: secondFile };
  codex.handle(ctx, s2, { type: 'session_meta', timestamp: iso(NOW), payload: { id: ID2, cwd: '/work/demo2' } });
  codex.handle(ctx, s2, { type: 'event_msg', timestamp: iso(NOW + 1000), payload: { type: 'task_started', turn_id: 'T2' } });
  codex.handle(ctx, s2, { type: 'event_msg', timestamp: iso(NOW + 2000), payload: { type: 'task_complete', turn_id: 'T2' } });
  assert.strictEqual(s2.key, `acct2:${ID2}`, 'the key carries the account');
  const second = board.snapshot().entries.filter(e => e.detail && e.detail.account === 'acct2');
  assert.strictEqual(second.length, 2, 'prompt and turn rows are labelled with the account');
  assert.ok(second.every(e => e.detail.session === `acct2:${ID2}`));

  const s1 = { file: firstFile };
  codex.handle(ctx, s1, { type: 'session_meta', timestamp: iso(NOW), payload: { id: ID1, cwd: '/work/demo' } });
  codex.handle(ctx, s1, { type: 'event_msg', timestamp: iso(NOW + 1000), payload: { type: 'task_started', turn_id: 'T1' } });
  assert.strictEqual(s1.key, ID1, 'account 1 keeps its plain key');
  const first = board.snapshot().entries.filter(e => e.detail && e.detail.account === '');
  assert.ok(first.length >= 1 && first.every(e => e.detail.session === ID1));

  // Today's cost from the collector follows the file: same id, two accounts, two rows.
  sessions.cost({ provider: 'codex', file: secondFile, cost: 2, at: NOW });
  sessions.cost({ provider: 'codex', file: firstFile, cost: 5, at: NOW });
  const rows = sessions.rows().filter(row => row.provider === 'codex');
  assert.deepStrictEqual(rows.map(row => [row.key, row.account, row.costToday]).sort(),
    [[ID1, '', 5], [`acct2:${ID2}`, 'acct2', 2]], 'each account gets its own session and cost');
});

// Fake `codex app-server`: one child per call, answering initialize and the rateLimits read.
function fakeCodexSpawn(calls, { failHome = null } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts && opts.env ? { ...opts.env } : null });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.kill = () => {};
    const failing = failHome && opts && opts.env && opts.env.CODEX_HOME === failHome;
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ id: 1, result: { platformOs: 'linux' } }) + '\n');
      setImmediate(() => {
        if (failing) {
          child.stdout.emit('data', JSON.stringify({ id: 2, error: { message: 'quota check failed' } }) + '\n');
          return;
        }
        child.stdout.emit('data', JSON.stringify({
          id: 2,
          result: {
            rateLimits: {
              planType: 'plus',
              primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: Math.floor(NOW / 1000) + 3600 },
              secondary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: Math.floor(NOW / 1000) + 86400 },
            },
          },
        }) + '\n');
      });
    });
    return child;
  };
}

test('codex limits: one app-server call per CODEX_HOME, the second row is CODEX 2', async () => {
  const home = tempHome();
  const second = path.join(home, '.codex-acct2');
  fs.mkdirSync(second, { recursive: true });
  const calls = [];
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({
    board, home, now: () => NOW, timers: false,
    claudeFile: path.join(home, 'missing.json'), ompProfiles: [], spawnFn: fakeCodexSpawn(calls),
  });
  await lim.refresh('codex');
  lim.dispose();
  const snap = board.snapshot().limits.codex;
  assert.strictEqual(snap.status, 'ok');
  assert.deepStrictEqual(snap.accounts.map(a => [a.name, a.plan, a.windows.map(w => w.label)]), [
    ['CODEX', 'plus', ['5h', 'Week']],
    ['CODEX 2', 'plus', ['5h', 'Week']],
  ]);
  assert.strictEqual(calls.length, 2, 'one app-server per account');
  const secondCall = calls.find(call => call.env && call.env.CODEX_HOME === second);
  assert.ok(secondCall, 'account 2 runs with its own CODEX_HOME');
  assert.deepStrictEqual(secondCall.args, ['app-server']);
  assert.ok(!(calls[0].env && calls[0].env.CODEX_HOME === second), 'account 1 keeps the real environment');
});

test('codex limits: without .codex-acct2 there is one CODEX row and one call', async () => {
  const home = tempHome();
  const calls = [];
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({
    board, home, now: () => NOW, timers: false,
    claudeFile: path.join(home, 'missing.json'), ompProfiles: [], spawnFn: fakeCodexSpawn(calls),
  });
  await lim.refresh('codex');
  lim.dispose();
  const snap = board.snapshot().limits.codex;
  assert.deepStrictEqual(snap.accounts.map(a => a.name), ['CODEX']);
  assert.strictEqual(calls.length, 1);
});

test('codex limits: one account failing leaves the other account intact', async () => {
  const home = tempHome();
  const second = path.join(home, '.codex-acct2');
  fs.mkdirSync(second, { recursive: true });
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({
    board, home, now: () => NOW, timers: false,
    claudeFile: path.join(home, 'missing.json'), ompProfiles: [], spawnFn: fakeCodexSpawn([], { failHome: second }),
  });
  await lim.refresh('codex');
  lim.dispose();
  const snap = board.snapshot().limits.codex;
  assert.strictEqual(snap.status, 'ok', 'the working account still sets the row');
  const first = snap.accounts.filter(a => a.name === 'CODEX');
  assert.strictEqual(first.length, 1);
  assert.deepStrictEqual(first[0].windows.map(w => w.label), ['5h', 'Week']);
  const failed = snap.accounts.filter(a => a.name === 'CODEX 2');
  assert.strictEqual(failed.length, 1, 'the failed account gets one no-data row');
  assert.deepStrictEqual(failed[0].windows, []);
  assert.strictEqual(failed[0].error, 'quota check failed');
});

const COLS = 'id INTEGER, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER';

function openLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE logs(${COLS})`);
  return {
    db,
    insert(row) {
      db.prepare('INSERT INTO logs(id, ts, target, thread_id, feedback_log_body) VALUES(?, ?, ?, ?, ?)')
        .run(row.id, Math.floor(NOW / 1000), row.target, row.thread, row.body);
    },
  };
}

(DatabaseSyncMissing ? test.skip : test)('codex-log: the second CODEX_HOME database opens its own turn, labelled acct2', (t) => {
  const home = tempHome();
  const firstFile = path.join(home, '.codex', 'logs_2.sqlite');
  const secondFile = path.join(home, '.codex-acct2', 'logs_2.sqlite');
  const first = openLog(firstFile);
  const second = openLog(secondFile);
  const sessions = createSessions({ now: () => NOW });
  const board = createBoard({ now: () => NOW, sessions });
  const log = startCodexLog({ board, home, now: () => NOW, timers: false });
  t.after(() => {
    try { log.dispose(); } catch { /* ignore */ }
    try { first.db.close(); } catch { /* ignore */ }
    try { second.db.close(); } catch { /* ignore */ }
  });
  const TURN_A = 'aaaa1111-2222-7333-8444-555566667777';
  const TURN_B = 'bbbb1111-2222-7333-8444-555566667777';
  const submission = (thread, turn) => `session_loop{thread_id=${thread}}: Submission sub=Submission { id: "${turn}", op: TurnInput { prompt: "SECRET-PROMPT-TEXT" } }`;
  first.insert({ id: 1, target: 'codex_core::session::handlers', thread: 'thread-a', body: submission('thread-a', TURN_A) });
  second.insert({ id: 1, target: 'codex_core::session::handlers', thread: 'thread-a', body: submission('thread-a', TURN_B) });
  log.poll();
  const entries = board.snapshot().entries;
  const one = entries.find(e => e.id === `codex-turn-${TURN_A}`);
  const two = entries.find(e => e.id === `codex-turn-${TURN_B}`);
  assert.ok(one && one.status === 'run', 'account 1 turn opened');
  assert.ok(two && two.status === 'run', 'account 2 turn opened');
  assert.strictEqual(two.detail.account, 'acct2');
  assert.strictEqual(two.detail.session, 'acct2:thread-a');
  assert.strictEqual(one.detail.session, 'thread-a');
  const rows = sessions.rows().filter(row => row.provider === 'codex');
  assert.deepStrictEqual(rows.map(row => [row.key, row.account]).sort(), [['acct2:thread-a', 'acct2'], ['thread-a', '']]);
  assert.ok(!JSON.stringify(board.snapshot()).includes('SECRET-PROMPT-TEXT'), 'prompt text never leaves the log');
});

(DatabaseSyncMissing ? test.skip : test)('collector: usage rows from the second CODEX_HOME log are priced', async () => {
  const home = tempHome();
  const file = path.join(home, '.codex-acct2', 'logs_2.sqlite');
  const log = openLog(file);
  log.insert({ id: 1, target: 'codex_core::session::turn', thread: 'thread-b', body: 'turn: post sampling token usage total_usage_tokens=1000' });
  log.db.close();

  const ledger = createLedger({ now: () => NOW });
  const collector = startCollector({
    ledger, home, now: () => NOW, timers: false, cacheFile: path.join(home, 'cache.json'),
  });
  await collector.ready;
  try {
    const codexUsage = ledger.periods(NOW).today.per.codex;
    assert.strictEqual(codexUsage.rough, true);
    assert.ok(Math.abs(codexUsage.cost - 1000 * 1.25 / 1e6) < 1e-12, 'the second home row is priced like the first');
  } finally {
    collector.close();
  }
  const cache = fs.readFileSync(path.join(home, 'cache.json'), 'utf8');
  assert.ok(!cache.includes('SECRET'), 'the cache holds counts only');
});
