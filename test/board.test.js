const { test } = require('node:test');
const assert = require('node:assert');
const { createBoard } = require('../lib/board');

const entry = (id, over = {}) => ({
  id,
  provider: 'claude',
  station: 'model',
  label: 'x',
  status: 'ok',
  startedAt: 1_000_000,
  project: 'demo',
  detail: { kind: 'k', project: 'demo', session: 's' },
  ...over,
});

test('board: duplicate id is dropped, keep cap trims, stale run is shown as ok', () => {
  let t = 1_000_000;
  const board = createBoard({ now: () => t, keep: 3, staleRunMs: 60e3 });
  assert.strictEqual(board.add(entry('a')), true);
  assert.strictEqual(board.add(entry('a')), false);
  assert.strictEqual(board.snapshot().entries.length, 1);
  board.add(entry('b'));
  board.add(entry('c'));
  board.add(entry('d'));
  assert.deepStrictEqual(board.snapshot().entries.map(e => e.id), ['b', 'c', 'd']);
  assert.strictEqual(board.snapshot().counts.model, 4);
  t += 61e3;
  board.add(entry('r1', { provider: 'omp', station: 'shell', label: 'Bash git', status: 'run' }));
  const r = board.snapshot().entries.find(e => e.id === 'r1');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.endedAt, r.startedAt);
});

test('board: entries older than maxAgeMs are dropped', () => {
  const board = createBoard({ now: () => 10_000, maxAgeMs: 1000 });
  board.add(entry('old', { startedAt: 5_000 }));
  assert.strictEqual(board.snapshot().entries.length, 0);
});

test('board: sessions counts only sessions touched in the last 120 s', () => {
  let t = 2_000_000;
  const board = createBoard({ now: () => t });
  board.touch('claude', 'a');
  board.touch('claude', 'b');
  board.touch('codex', 'c');
  t += 119e3;
  board.touch('omp', 'd');
  assert.deepStrictEqual(board.snapshot().sessions, { claude: 2, codex: 1, omp: 1 });
  t += 2e3;
  assert.deepStrictEqual(board.snapshot().sessions, { claude: 0, codex: 0, omp: 1 });
});

test('board: setModel cleans, addCost sums and ignores junk, finish patches label', () => {
  const board = createBoard({ now: () => 5_000 });
  board.setModel('claude', 'claude-opus-4-1\n');
  assert.strictEqual(board.snapshot().models.claude, 'opus-4-1');
  board.setModel('omp', 'openai/gpt-5-thinking');
  assert.strictEqual(board.snapshot().models.omp, 'gpt-5-thinking');
  board.addCost('omp', NaN);
  board.addCost('omp', -2);
  board.addCost('omp', 0);
  assert.strictEqual(board.snapshot().usage.omp, undefined);
  board.addCost('omp', 1.5);
  board.addCost('omp', 2.25);
  assert.deepStrictEqual(board.snapshot().usage.omp, { last: 2.25, session: 3.75, lastAt: 5_000 });
  board.setPresence({ claude: true, codex: false, omp: true });
  assert.deepStrictEqual(
    board.snapshot().presence,
    { claude: true, codex: false, omp: true, at: 5_000 }
  );
  board.add(entry('w1', { status: 'run' }));
  assert.strictEqual(board.finish('w1', 'ok', 6_000, { label: 'done thing' }), true);
  const w = board.snapshot().entries.find(e => e.id === 'w1');
  assert.strictEqual(w.status, 'ok');
  assert.strictEqual(w.label, 'done thing');
  assert.strictEqual(board.finish('missing', 'ok', 6_000), false);
});

test('board: markCosted is per provider and capped, a rough estimate stays rough', () => {
  const board = createBoard({ now: () => 7_000 });
  assert.strictEqual(board.isCosted('codex', 't1'), false);
  board.markCosted('codex', 't1');
  assert.strictEqual(board.isCosted('codex', 't1'), true);
  assert.strictEqual(board.isCosted('claude', 't1'), false, 'providers do not share the set');
  board.addCost('codex', 0.5, { rough: true });
  board.addCost('codex', 0.25);
  const usage = board.snapshot().usage.codex;
  assert.strictEqual(usage.rough, true, 'a mixed total is still an estimate');
  assert.strictEqual(usage.session, 0.75);
  for (let i = 0; i < 10_001; i++) board.markCosted('omp', `id-${i}`);
  assert.strictEqual(board.isCosted('omp', 'id-0'), false, 'the oldest id is dropped at the cap');
  assert.strictEqual(board.isCosted('omp', 'id-10000'), true);
});

test('board: modelsInUse lists every model seen in the last 30 min per agent, newest first, old lines ignored', () => {
  const { createBoard } = require('../lib/board');
  let t = 1_700_000_000_000;
  const board = createBoard({ now: () => t });
  board.setModel('claude', 'claude-opus-5-5', t - 60e3, 's1');
  board.setModel('claude', 'claude-haiku-5-5', t - 10e3, 's2');
  board.setModel('claude', 'claude-sonnet-5-5', t - 40 * 60e3, 's3');
  board.setModel('omp', 'opencode-go/deepseek-v4.1-flash', t - 5e3, 'o1');
  const inUse = board.snapshot().modelsInUse;
  assert.deepStrictEqual(inUse.claude.map(x => x.model), ['haiku-5-5', 'opus-5-5']);
  assert.deepStrictEqual(inUse.omp.map(x => x.model), ['deepseek-v4.1-flash']);
  assert.deepStrictEqual(inUse.codex, []);
  t += 31 * 60e3;
  assert.deepStrictEqual(board.snapshot().modelsInUse.claude, [], 'they drop out after 30 min');
});

test('sessions: a model is set only on its own session', () => {
  const { createSessions } = require('../lib/sessions');
  const t = 1_700_000_000_000;
  const sessions = createSessions({ now: () => t });
  for (const key of ['a', 'b']) sessions.note({ id: key + '1', provider: 'claude', station: 'shell', label: 'Bash git', status: 'ok', startedAt: t - 1000, project: 'p', detail: { session: key } });
  sessions.setModel('claude', 'haiku-5-5', 'a');
  sessions.setModel('claude', 'opus-5-5', 'b');
  const byKey = Object.fromEntries(sessions.rows().map(r => [r.key, r.model]));
  assert.deepStrictEqual(byKey, { a: 'haiku-5-5', b: 'opus-5-5' });
});
