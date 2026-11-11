const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
if (DatabaseSyncMissing) {
  test('codex-log: skipped (node:sqlite unavailable)', (t, done) => {
    console.log('SKIP codex-log: node:sqlite is unavailable in this Node build');
    done();
  });
}

const { createBoard } = require('../lib/board');
const { startCodexLog } = DatabaseSyncMissing ? {} : require('../lib/sources/codex-log');

const NOW = 1_700_000_000_000;
const NOW_S = Math.floor(NOW / 1000);
const COLS = 'id INTEGER, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER';
const TURN = '0aaa1111-2222-7333-8444-555566667777';
const SUB_BODY = `session_loop{thread_id=0bbb1111-2222-7333-8444-555566667777}: Submission sub=Submission { id: "${TURN}", op: TurnInput { prompt: "SECRET-PROMPT-TEXT" } }`;
const TOOL_BODY = 'session_loop{thread_id=T-1}:submission_dispatch{turn_id=T-1 model=gpt-5.6-sol cwd=/home/user/demo}: turn_id=T-1 tool_name=exec call_id=call_abc123 tool_source="direct" execution_started=true dispatch_duration_ms=0 handler_duration_ms=90 total_duration_ms=90';

function reader(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-codexlog-'));
  const file = path.join(home, 'logs_7.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE logs(${COLS})`);
  let clock = NOW;
  const board = createBoard({ now: () => clock });
  const log = startCodexLog({
    board, home: '/nonexistent-home-dir', now: () => clock, dbPath: file, timers: false, ...opts,
  });
  t.after(() => {
    try { log.dispose(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  });
  let id = 0;
  const insert = (row) => {
    id += 1;
    db.prepare('INSERT INTO logs(id, ts, target, thread_id, feedback_log_body) VALUES(?, ?, ?, ?, ?)').run(
      id, row.ts ?? Math.floor(clock / 1000), row.target, row.thread_id ?? null, row.body ?? '');
    return id;
  };
  return {
    board, log, insert, clock: v => { clock = v; },
    entries: () => board.snapshot().entries,
  };
}

(DatabaseSyncMissing ? test.skip : test)('codex-log: rows that existed before start are not replayed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-codexlog-'));
  const file = path.join(dir, 'logs_7.sqlite');
  const setup = new DatabaseSync(file);
  setup.exec(`CREATE TABLE logs(${COLS})`);
  setup.prepare('INSERT INTO logs(id, ts, target, thread_id, feedback_log_body) VALUES(1, ?, ?, ?, ?)').run(
    NOW_S, 'codex_core::session::handlers', 'T-old', SUB_BODY);
  setup.close();
  const board = createBoard({ now: () => NOW });
  const log = startCodexLog({ board, home: '/nonexistent-home-dir', now: () => NOW, dbPath: file, timers: false });
  try {
    assert.strictEqual(log.enabled, true);
    log.poll();
    assert.strictEqual(board.snapshot().entries.length, 0);
  } finally {
    log.dispose();
  }
});

(DatabaseSyncMissing ? test.skip : test)('codex-log: a turn opens, a finished tool is recorded with its duration, turn/completed closes the turn', (t) => {
  const r = reader(t);
  r.insert({ target: 'codex_core::session::handlers', thread_id: 'T-1', body: SUB_BODY });
  r.insert({ target: 'codex_core::tools::parallel', thread_id: 'T-1', body: TOOL_BODY });
  r.log.poll();
  const open = r.entries();
  const you = open.find(e => e.id === `codex-you-${TURN}`);
  const turn = open.find(e => e.id === `codex-turn-${TURN}`);
  assert.ok(you && you.status === 'ok' && you.station === 'you', 'prompt marker recorded');
  assert.ok(turn && turn.status === 'run' && turn.station === 'model', 'turn running');
  const tool = open.find(e => e.id === 'codex-tool-call_abc123');
  assert.ok(tool, 'tool entry recorded');
  assert.strictEqual(tool.status, 'ok');
  assert.strictEqual(tool.station, 'shell');
  assert.strictEqual(tool.label, 'exec');
  assert.strictEqual(tool.endedAt - tool.startedAt, 90);
  assert.strictEqual(tool.project, 'demo');
  assert.strictEqual(r.board.snapshot().models.codex, 'gpt-5.6-sol');
  assert.strictEqual(r.board.snapshot().sessions.codex, 1);
  r.insert({ target: 'codex_app_server::outgoing_message', thread_id: null, body: 'app-server event: turn/completed ok' });
  r.log.poll();
  assert.strictEqual(r.entries().find(e => e.id === `codex-turn-${TURN}`).status, 'ok');
});

(DatabaseSyncMissing ? test.skip : test)('codex-log: the prompt text in the Submission row never reaches the snapshot', (t) => {
  const r = reader(t);
  r.insert({ target: 'codex_core::session::handlers', thread_id: 'T-9', body: SUB_BODY });
  r.log.poll();
  assert.ok(r.entries().some(e => e.id === `codex-turn-${TURN}`), 'turn recorded without its prompt');
  assert.ok(!JSON.stringify(r.board.snapshot()).includes('SECRET-PROMPT-TEXT'), 'prompt text leaked');
});

(DatabaseSyncMissing ? test.skip : test)('codex-log: two threads, turn/completed closes the most recently active one, the other closes after quietMs', (t) => {
  const r = reader(t, { quietMs: 60e3 });
  r.insert({ target: 'codex_core::session::handlers', thread_id: 'T-A', body: SUB_BODY.replace(TURN, '1'.repeat(8) + '-2222-7333-8444-555566667777') });
  r.clock(NOW + 1000);
  r.insert({ target: 'codex_core::session::handlers', thread_id: 'T-B', body: SUB_BODY.replace(TURN, '2'.repeat(8) + '-2222-7333-8444-555566667777') });
  r.log.poll();
  const idA = `codex-turn-${'1'.repeat(8)}-2222-7333-8444-555566667777`;
  const idB = `codex-turn-${'2'.repeat(8)}-2222-7333-8444-555566667777`;
  assert.strictEqual(r.entries().find(e => e.id === idA).status, 'run');
  assert.strictEqual(r.entries().find(e => e.id === idB).status, 'run');
  r.insert({ target: 'codex_app_server::outgoing_message', thread_id: null, body: 'app-server event: turn/completed ok' });
  r.log.poll();
  assert.strictEqual(r.entries().find(e => e.id === idA).status, 'run', 'older thread stays open');
  assert.strictEqual(r.entries().find(e => e.id === idB).status, 'ok', 'newest thread closed');
  r.clock(NOW + 1000 + 61e3);
  r.log.poll();
  assert.strictEqual(r.entries().find(e => e.id === idA).status, 'ok', 'quiet thread closed after quietMs');
});

(DatabaseSyncMissing ? test.skip : test)('codex-log: ids match the rollout source so the same tool is not doubled', (t) => {
  const r = reader(t);
  r.board.add({
    id: 'codex-tool-call_x', provider: 'codex', station: 'shell', label: 'exec',
    status: 'run', startedAt: NOW, project: 'codex',
    detail: { kind: 'Codex tool call', tool: 'exec', project: 'codex', session: 's' },
  });
  r.insert({
    target: 'codex_core::tools::parallel', thread_id: 'T-1',
    body: 'x{thread_id=T-1}:submission_dispatch{model=gpt-5.6-sol cwd=/home/user/demo}: turn_id=U tool_name=exec call_id=call_x tool_source="direct" total_duration_ms=10',
  });
  r.log.poll();
  const tools = r.entries().filter(e => e.id === 'codex-tool-call_x');
  assert.strictEqual(tools.length, 1, 'tool entry appears once');
  assert.strictEqual(tools[0].status, 'ok', 'running rollout tool finished by the log row');
});

(DatabaseSyncMissing ? test.skip : test)('codex-log: a missing database gives a disabled reader and no throw', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-codexlog-'));
  const board = createBoard({ now: () => NOW });
  const log = startCodexLog({ board, home, now: () => NOW, timers: false });
  try {
    assert.strictEqual(log.enabled, false);
    assert.doesNotThrow(() => log.poll());
  } finally {
    log.dispose();
  }
});

(DatabaseSyncMissing ? test.skip : test)('codex-log: only filters threads once their cwd is known', (t) => {
  const r = reader(t, { only: '/home/user/demo' });
  r.insert({
    target: 'codex_core::tools::parallel', thread_id: 'T-out',
    body: 'x{thread_id=T-out}:submission_dispatch{model=gpt-5.6-sol cwd=/elsewhere/x}: turn_id=U tool_name=exec call_id=call_out tool_source="direct" total_duration_ms=5',
  });
  r.insert({
    target: 'codex_core::session::handlers', thread_id: 'T-in',
    body: SUB_BODY.replace(TURN, '3'.repeat(8) + '-2222-7333-8444-555566667777'),
  });
  r.log.poll();
  assert.ok(!r.entries().some(e => e.id === 'codex-tool-call_out'), 'outside prefix not recorded');
  assert.ok(r.entries().some(e => e.id === `codex-turn-${'3'.repeat(8)}-2222-7333-8444-555566667777`), 'unknown cwd recorded');
});

test('board: patch updates project on the newest entry with that id', () => {
  const board = createBoard({ now: () => NOW });
  const base = {
    provider: 'codex', station: 'model', label: 'Codex working', status: 'run',
    startedAt: NOW, project: 'codex', detail: { kind: 'Codex turn (live log)', project: 'codex', session: 'T-1' },
  };
  assert.strictEqual(board.add({ id: 'x', ...base }), true);
  assert.strictEqual(board.add({ id: 'x', ...base, startedAt: NOW + 1 }), false);
  assert.strictEqual(board.patch('x', undefined), true);
  board.finish('x', 'ok', NOW);
  assert.strictEqual(board.add({ id: 'y', ...base }), true);
  assert.strictEqual(board.add({ id: 'y', ...base, startedAt: NOW + 1, status: 'ok' }), false);
  assert.strictEqual(board.patch('y', { project: 'demo', detail: { project: 'demo' } }), true);
  const snap = board.snapshot().entries.filter(e => e.id === 'y');
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0].project, 'demo');
  assert.strictEqual(snap[0].detail.project, 'demo');
  assert.strictEqual(snap[0].detail.kind, 'Codex turn (live log)', 'other detail fields kept');
  assert.strictEqual(board.patch('missing', { project: 'demo' }), false);
});
