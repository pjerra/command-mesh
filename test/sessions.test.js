const { test } = require('node:test');
const assert = require('node:assert');
const { createBoard } = require('../lib/board');
const { createSessions } = require('../lib/sessions');

test('sessions: rows sort flagged first, idle flag needs an open turn, subagent label', () => {
  const t = 1_700_000_000_000;
  const now = () => t;
  const sessions = createSessions({ now });
  const board = createBoard({ now, sessions });
  board.setModel('claude', 'opus-5-5');

  // Open turn, quiet for 15 minutes: working and went quiet, so it is flagged.
  board.add({
    id: 'a-run', provider: 'claude', station: 'model', label: 'Claude working', status: 'run',
    startedAt: t - 15 * 60e3, project: 'wt-hakkar-r12', detail: { kind: 'Claude turn', session: 'sess-a' },
  });
  // A finished turn idle for 19 minutes: just dim, no flag.
  board.add({
    id: 'b-run', provider: 'claude', station: 'model', label: 'Claude working', status: 'run',
    startedAt: t - 20 * 60e3, project: 'wt-ony-refuse-reasons', detail: { kind: 'Claude turn', session: 'sess-b' },
  });
  board.finish('b-run', 'ok', t - 19 * 60e3);
  // A subagent tool: the row is labelled as a subagent.
  board.add({
    id: 'c-tool', provider: 'claude', station: 'files', label: 'Read raid_walk.go', status: 'run',
    startedAt: t - 5e3, project: 'dads-mmo-lab',
    detail: { kind: 'Claude subagent tool', subagent: true, session: 'sess-c' },
  });

  const rows = sessions.rows();
  assert.deepStrictEqual(rows.map(row => row.key), ['sess-a', 'sess-c', 'sess-b'], 'flagged first, then newest activity');
  assert.strictEqual(rows[0].idleFlag, true, 'an open turn idle over 10 minutes is flagged');
  assert.strictEqual(rows[0].running, true);
  assert.ok(rows[0].idleMs >= 15 * 60e3);

  const quiet = rows[2];
  assert.strictEqual(quiet.key, 'sess-b');
  assert.strictEqual(quiet.idleFlag, false, 'a finished turn that is idle is not flagged');
  assert.ok(quiet.idleMs >= 19 * 60e3);

  const sub = rows[1];
  assert.strictEqual(sub.key, 'sess-c');
  assert.strictEqual(sub.sub, true);
  assert.strictEqual(sub.name, 'dads-mmo-lab \u00b7 subagent');
  assert.strictEqual(sub.model, 'opus-5-5');
  assert.ok(rows.every(row => row.model === 'opus-5-5'), 'board model reaches every session');
});

test('sessions: errors flag at 3 in 10 min; idle > 2 h is forgotten', () => {
  const t = 1_700_000_000_000;
  const sessions = createSessions({ now: () => t });
  const err = (session, index, ageMs) => ({
    id: `err-${session}-${index}`, provider: 'claude', station: 'shell', label: 'Bash go test', status: 'err',
    startedAt: t - ageMs, endedAt: t - ageMs, project: 'proj',
    detail: { kind: 'Claude tool', session },
  });

  sessions.note(err('sess-three', 0, 60e3));
  sessions.note(err('sess-three', 1, 2 * 60e3));
  sessions.note(err('sess-three', 2, 3 * 60e3));
  sessions.note(err('sess-two', 0, 60e3));
  sessions.note(err('sess-two', 1, 2 * 60e3));

  const rows = sessions.rows();
  const three = rows.find(row => row.key === 'sess-three');
  const two = rows.find(row => row.key === 'sess-two');
  assert.strictEqual(three.errorsRecent, 3);
  assert.strictEqual(three.errorFlag, true);
  assert.strictEqual(three.flagged, true);
  assert.strictEqual(two.errorsRecent, 2);
  assert.strictEqual(two.errorFlag, false);

  sessions.note({
    id: 'old-ok', provider: 'omp', station: 'model', label: 'old', status: 'ok',
    startedAt: t - 3 * 60 * 60e3, endedAt: t - 3 * 60 * 60e3, project: 'old',
    detail: { kind: 'OMP turn', session: 'sess-old' },
  });
  assert.strictEqual(sessions.has('omp', 'sess-old'), true);
  sessions.rows();
  assert.strictEqual(sessions.has('omp', 'sess-old'), false, 'a session idle over two hours is forgotten');
});
