const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBoard } = require('../lib/board');
const { startTail } = require('../lib/tail');
const claude = require('../lib/sources/claude');

const NOW = 1_700_000_100_000;

function promptLine(uuid, sessionId, cwd = '/home/user/demo', at = NOW) {
  return JSON.stringify({
    type: 'user',
    uuid,
    sessionId,
    cwd,
    timestamp: new Date(at).toISOString(),
    message: { content: 'fake prompt' },
  });
}

function memoryEntries(board) {
  return board.snapshot().entries.filter(entry => entry.station === 'memory');
}

test('claude: a new session file records memory loaded once; a subagent file says subagent; first-pass files do not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-memory-'));
  const root = path.join(home, '.claude', 'projects');
  const dir = path.join(root, 'demo');
  const subdir = path.join(dir, 'subagents');
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.jsonl'), promptLine('old1', 'old-session') + '\n');

  const board = createBoard({ now: () => NOW });
  const ctx = { board, now: () => NOW, only: '' };
  const tail = startTail({
    root,
    onEvent: (session, event) => claude.handle(ctx, session, event),
    now: () => NOW,
    timers: false,
  });

  try {
    tail.poll();
    assert.strictEqual(memoryEntries(board).length, 0, 'an old first-pass file never replays its start');

    fs.writeFileSync(path.join(dir, 'new.jsonl'), promptLine('new1', 'new-session') + '\n');
    fs.writeFileSync(path.join(subdir, 'agent-1.jsonl'), promptLine('sub1', 'sub-session') + '\n');
    tail.discover();
    tail.poll();
    const list = memoryEntries(board);
    assert.strictEqual(list.length, 2);
    const main = list.find(entry => entry.id === 'claude-mem-new-session');
    assert.ok(main, 'the main session lights Memory once');
    assert.strictEqual(main.label, 'memory loaded');
    assert.strictEqual(main.status, 'ok');
    assert.strictEqual(main.startedAt, NOW);
    assert.strictEqual(main.endedAt, NOW);
    const sub = list.find(entry => entry.id === 'claude-mem-sub-session');
    assert.ok(sub, 'the subagent file lights Memory too');
    assert.strictEqual(sub.label, 'memory loaded \u00b7 subagent');

    fs.appendFileSync(path.join(dir, 'new.jsonl'), promptLine('new2', 'new-session') + '\n');
    tail.discover();
    tail.poll();
    assert.strictEqual(memoryEntries(board).filter(entry => entry.id === 'claude-mem-new-session').length, 1, 'one file never lights Memory twice');
  } finally {
    tail.dispose();
  }

  const direct = createBoard({ now: () => NOW });
  claude.handle(
    { board: direct, now: () => NOW, only: '' },
    { file: '/x/new.jsonl', offset: 0, carry: '', cwd: '', key: '/x/new.jsonl', fresh: false },
    JSON.parse(promptLine('direct1', 'direct-session')),
  );
  assert.strictEqual(memoryEntries(direct).length, 0, 'a session that is not fresh records no memory entry');
});

test('claude: SessionStart compact hook records memory reloaded', () => {
  const board = createBoard({ now: () => NOW });
  const ctx = { board, now: () => NOW, only: '' };
  const session = { file: '/x/s.jsonl', offset: 0, carry: '', cwd: '/home/user/demo', key: 's1' };
  claude.handle(ctx, session, {
    type: 'attachment',
    uuid: 'compact-1',
    sessionId: 's1',
    timestamp: new Date(NOW).toISOString(),
    attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'compact-context', exitCode: 0 },
  });
  const reload = memoryEntries(board).find(entry => entry.id === 'claude-mem-compact-1');
  assert.ok(reload, 'the compact hook lights Memory');
  assert.strictEqual(reload.label, 'memory reloaded');
  assert.strictEqual(reload.station, 'memory');
  assert.strictEqual(reload.status, 'ok');
  assert.strictEqual(reload.startedAt, NOW);
  assert.strictEqual(reload.endedAt, NOW);

  claude.handle(ctx, session, {
    type: 'attachment',
    uuid: 'start-2',
    sessionId: 's1',
    timestamp: new Date(NOW).toISOString(),
    attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'load-context', exitCode: 0 },
  });
  assert.ok(!memoryEntries(board).some(entry => entry.id === 'claude-mem-start-2'), 'a plain SessionStart hook is not a reload');
});
