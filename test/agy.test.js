const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createBoard } = require('../lib/board');
const agy = require('../lib/sources/agy');
const { agyUsage } = require('../lib/usage/parse');

const NOW = Date.parse('2026-11-14T10:00:00Z');
const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const CONV = '11111111-2222-4333-8444-555555555555';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agy-'));
  const base = path.join(home, '.gemini', 'antigravity-cli');
  const logs = path.join(base, 'brain', CONV, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(path.join(base, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(base, 'cache', 'last_conversations.json'), JSON.stringify({ '/work/proj': CONV }));
  let t = NOW;
  const board = createBoard({ now: () => t });
  const ctx = { board, now: () => t, only: '' };
  const session = { file: path.join(logs, 'transcript_full.jsonl') };
  return { home, logs, ctx, session, board, tick: ms => { t += ms; } };
}

const user = (step, at) => ({ step_index: step, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(at), content: 'secret prompt' });
const plan = (step, at, calls) => ({
  step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(at), model: 'gemini-3.8-flash-high',
  input_tokens: 2000, cache_read_tokens: 7000, output_tokens: 400, thinking: 'secret thought', ...(calls ? { tool_calls: calls } : { content: 'answer' }),
});
const result = (step, at, status = 'DONE') => ({ step_index: step, source: 'MODEL', type: 'GENERIC', status, created_at: iso(at), content: 'secret output' });

test('agy: a turn with two tools, results in order, the model, the project and the session key', () => {
  const { ctx, session, board, tick } = setup();
  agy.handle(ctx, session, user(0, NOW));
  agy.handle(ctx, session, plan(1, NOW, [
    { name: 'run_command', args: { CommandLine: 'API_KEY=hunter2 npm test -- --secret', WaitMsBeforeAsync: 5000 } },
    { name: 'search_web', args: { query: 'secret query' } },
  ]));
  let snap = board.snapshot();
  let tools = snap.entries.filter(e => e.station === 'shell' || e.station === 'web');
  assert.deepStrictEqual(tools.map(e => [e.station, e.status]).sort(), [['shell', 'run'], ['web', 'run']]);
  assert.strictEqual(tools.find(e => e.station === 'shell').label, 'run_command npm');

  tick(3000);
  agy.handle(ctx, session, result(2, NOW + 3000));
  agy.handle(ctx, session, result(3, NOW + 3000, 'ERROR'));
  agy.handle(ctx, session, result(3, NOW + 3000)); // the same step again is ignored
  tick(2000);
  agy.handle(ctx, session, plan(4, NOW + 5000));

  snap = board.snapshot();
  const mine = snap.entries.filter(e => e.provider === 'gemini');
  assert.strictEqual(mine.find(e => e.station === 'shell').status, 'ok');
  assert.strictEqual(mine.find(e => e.station === 'web').status, 'err', 'the second result settles the second call');
  const turn = mine.find(e => e.station === 'model');
  assert.strictEqual(turn.status, 'ok', 'a reply with no tool calls ends the turn');
  assert.strictEqual(turn.project, 'proj', 'the project comes from last_conversations.json');
  assert.strictEqual(session.key, CONV);
  assert.deepStrictEqual(snap.modelsInUse.gemini.map(x => x.model), ['gemini-3.8-flash-high']);
  const text = JSON.stringify(snap);
  for (const secret of ['secret', 'hunter2']) assert.ok(!text.includes(secret), `${secret} must not reach the board`);
});

test('agy: only transcript_full.jsonl is read; a failed model step ends the turn as an error', () => {
  const { ctx, session, board, logs } = setup();
  const copy = { file: path.join(logs, 'transcript.jsonl') };
  const chunk = { file: path.join(logs, 'chunks', 'transcript_full', '00000000.jsonl') };
  agy.handle(ctx, copy, user(0, NOW));
  agy.handle(ctx, chunk, user(0, NOW));
  assert.strictEqual(board.snapshot().entries.length, 0);

  agy.handle(ctx, session, user(0, NOW));
  agy.handle(ctx, session, { ...plan(1, NOW), status: 'ERROR' });
  assert.strictEqual(board.snapshot().entries.find(e => e.station === 'model').status, 'err');
});

test('agy usage: one record per model step from transcript_full only; cost 0; mapped to the conversation', () => {
  const { session, logs } = setup();
  const state = { file: session.file };
  const record = agyUsage(plan(1, NOW), state);
  assert.deepStrictEqual(
    { input: record.input, cacheRead: record.cacheRead, output: record.output, cost: record.cost, provider: record.provider, model: record.model },
    { input: 2000, cacheRead: 7000, output: 400, cost: 0, provider: 'gemini', model: 'gemini-3.8-flash-high' },
  );
  assert.strictEqual(agyUsage(plan(1, NOW), state), null, 'the same step is not counted twice');
  assert.strictEqual(agyUsage(user(0, NOW), state), null);
  assert.strictEqual(agyUsage(plan(2, NOW), { file: path.join(logs, 'transcript.jsonl') }), null);
  assert.strictEqual(agyUsage(plan(2, NOW), { file: path.join(logs, 'chunks', 'transcript_full', '00000000.jsonl') }), null);

});

test('agy limits: /usage JSON becomes two AGY rows (gemini, claude·gpt) with 5h and Week', async () => {
  const { parseAgyUsage, startLimits } = require('../lib/limits');
  const bucket = (id, window, left, reset) => ({ id, name: 'x', window, remaining_fraction: left, reset_time: reset });
  const out = JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [bucket('g-w', 'weekly', 0.75, '2026-11-21T20:00:00Z'), bucket('g-5', '5h', 0, '2026-11-14T12:00:00Z')] },
    { name: 'Claude and GPT models', buckets: [bucket('c-w', 'weekly', 1, '2026-11-21T20:00:00Z'), bucket('c-5', '5h', 1, '2026-11-14T12:00:00Z')] },
  ] } } });
  const accounts = parseAgyUsage(out);
  assert.deepStrictEqual(accounts.map(a => [a.name, a.plan, a.windows.map(w => w.label)]), [
    ['AGY', 'gemini', ['5h', 'Week']],
    ['AGY', 'claude·gpt', ['5h', 'Week']],
  ]);
  const [five, week] = accounts[0].windows;
  assert.deepStrictEqual([five.usedPercent, five.exhausted, week.usedPercent, week.resetsAt, week.windowMs],
    [100, true, 25, Date.parse('2026-11-21T20:00:00Z'), 7 * 24 * 3600e3]);
  assert.strictEqual(parseAgyUsage('not json'), null);

  const set = {};
  const board = { setLimits: (s, r) => { set[s] = r; } };
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return cmd === '/bin/agy' ? { code: 0, stdout: out } : { code: -1, error: 'ENOENT' }; };
  const limits = startLimits({ board, home: '/nowhere', timers: false, run, ompProfiles: [], claudeFile: '/nowhere/x.json', agyBinary: '/bin/agy' });
  await limits.refresh('gemini');
  assert.strictEqual(set.gemini.status, 'ok');
  assert.strictEqual(set.gemini.accounts.length, 2);
  assert.deepStrictEqual(calls[0], ['/bin/agy', '-p', '/usage', '--output-format', 'json', '--print-timeout', '40s']);
  const missing = startLimits({ board, home: '/nowhere', timers: false, run, ompProfiles: [], claudeFile: '/nowhere/x.json', agyBinary: 'agy-not-here' });
  await missing.refresh('gemini');
  assert.strictEqual(set.gemini.status, 'disabled', 'no agy installed: no row');
});
