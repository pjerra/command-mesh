const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createBoard } = require('../lib/board');
const agy = require('../lib/sources/agy');
const { agyUsage } = require('../lib/usage/parse');
const { walkJsonl } = require('../lib/tail');
const { startLimits } = require('../lib/limits');

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
  assert.strictEqual(session.key, `acct1:${CONV}`);
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
    ['AGY acct1', 'gemini', ['5h', 'Week']],
    ['AGY acct1', 'claude·gpt', ['5h', 'Week']],
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

const CONV2 = '22222222-3333-4444-8555-666666666666';

function seedAgyConversation(cli, conversation) {
  const logs = path.join(cli, 'brain', conversation, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(path.join(cli, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(cli, 'cache', 'last_conversations.json'), JSON.stringify({ '/work/proj': conversation }));
  const file = path.join(logs, 'transcript_full.jsonl');
  fs.writeFileSync(file, '');
  return file;
}

test('agy: account homes are read separately, keyed by account, and a mirror symlink is not followed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-agy-acct-'));
  const cli1 = path.join(home, '.gemini', 'antigravity-cli');
  const cli2 = path.join(home, '.agy-acct2', '.gemini', 'antigravity-cli');
  const file1 = seedAgyConversation(cli1, CONV);
  const file2 = seedAgyConversation(cli2, CONV2);

  // A profile home mirrors the real home with symlinks: none of them may be walked.
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'proj', 'not-agy.jsonl'), '{}');
  fs.symlinkSync(path.join(home, '.claude'), path.join(home, '.agy-acct2', '.claude'), 'dir');
  fs.symlinkSync(path.join(cli1, 'brain'), path.join(cli2, 'brain', 'mirror'), 'dir');
  // Not an account: N = 1, a non-numeric name, and a profile whose .gemini is itself a symlink.
  fs.mkdirSync(path.join(home, '.agy-acct1', '.gemini', 'antigravity-cli'), { recursive: true });
  fs.mkdirSync(path.join(home, '.agy-acctx', '.gemini', 'antigravity-cli'), { recursive: true });
  fs.mkdirSync(path.join(home, '.agy-acct3'), { recursive: true });
  fs.symlinkSync(path.join(home, '.gemini'), path.join(home, '.agy-acct3', '.gemini'), 'dir');

  assert.deepStrictEqual(agy.accounts(home).map(a => a.label), ['acct1', 'acct2']);
  const found = [];
  for (const dir of agy.roots(home)) walkJsonl(dir, 6, found);
  assert.deepStrictEqual(found.sort(), [file1, file2].sort(), 'only the two real transcripts, no mirror duplicates');

  const board = createBoard({ now: () => NOW });
  const ctx = { board, now: () => NOW, only: '' };
  for (const [file, step] of [[file1, 0], [file2, 10]]) {
    const session = { file };
    agy.handle(ctx, session, user(step, NOW));
    agy.handle(ctx, session, plan(step + 1, NOW));
  }
  const snap = board.snapshot();
  const keys = [...new Set(snap.entries.filter(e => e.provider === 'gemini').map(e => e.detail.session))].sort();
  assert.deepStrictEqual(keys, [`acct1:${CONV}`, `acct2:${CONV2}`], 'each session carries its account');
  assert.strictEqual(snap.sessions.gemini, 2, 'the AGY core counts both accounts');
});

test('agy: the same conversation id in two accounts stays two sessions and two usage keys', () => {
  const file1 = `/home/u/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`;
  const file2 = `/home/u/.agy-acct2/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`;
  assert.strictEqual(agy.sessionKeyOf(file1), `acct1:${CONV}`);
  assert.strictEqual(agy.sessionKeyOf(file2), `acct2:${CONV}`);
  const first = agyUsage(plan(1, NOW), { file: file1 });
  const second = agyUsage(plan(1, NOW), { file: file2 });
  assert.strictEqual(first.key, `agy:acct1:${CONV}:1`);
  assert.strictEqual(second.key, `agy:acct2:${CONV}:1`);
  assert.notStrictEqual(first.key, second.key);
});

const agyBucket = (id, window, left, reset) => ({ id, name: 'x', window, remaining_fraction: left, reset_time: reset });
function agyUsageJson({ fiveHour = true } = {}) {
  const buckets = (short, week) => [
    ...(fiveHour ? [agyBucket(`${short}-5`, '5h', 1, '2026-11-14T12:00:00Z')] : []),
    agyBucket(`${short}-w`, 'weekly', week, '2026-11-21T20:00:00Z'),
  ];
  return JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          { name: 'Gemini Models', buckets: buckets('g', 0.75) },
          { name: 'Claude and GPT models', buckets: buckets('c', 1) },
        ],
      },
    },
  });
}

test('agy limits: one /usage call per account; account 2 has no five-hour bucket; labels carry the account', async () => {
  const board = createBoard({ now: () => NOW });
  const calls = [];
  const acct2Home = '/home/u/.agy-acct2';
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: cmd === 'env' ? agyUsageJson({ fiveHour: false }) : agyUsageJson() };
  };
  const lim = startLimits({
    board, home: '/nowhere', now: () => NOW, timers: false, run, ompProfiles: [], claudeFile: '/nowhere/x.json',
    agyBinary: '/bin/agy',
    agyAccounts: [{ label: 'acct1', home: '/home/u', primary: true }, { label: 'acct2', home: acct2Home, primary: false }],
  });
  await lim.refresh('gemini');
  lim.dispose();
  const snap = board.snapshot().limits.gemini;
  assert.strictEqual(snap.status, 'ok');
  assert.deepStrictEqual(snap.accounts.map(a => [a.name, a.plan, a.windows.map(w => w.label)]), [
    ['AGY acct1', 'gemini', ['5h', 'Week']],
    ['AGY acct1', 'claude·gpt', ['5h', 'Week']],
    ['AGY acct2', 'gemini', ['Week']],
    ['AGY acct2', 'claude·gpt', ['Week']],
  ]);
  const second = snap.accounts.find(a => a.name === 'AGY acct2' && a.plan === 'gemini');
  const weekly = second.windows[0];
  assert.deepStrictEqual([weekly.usedPercent, weekly.resetsAt], [25, Date.parse('2026-11-21T20:00:00Z')]);
  const envCall = calls.find(call => call[0] === 'env');
  assert.deepStrictEqual(envCall, ['env', `HOME=${acct2Home}`, '/bin/agy', '-p', '/usage', '--output-format', 'json', '--print-timeout', '40s']);
});

test('agy limits: one account failing leaves the other account intact', async () => {
  const board = createBoard({ now: () => NOW });
  const run = async cmd => (cmd === 'env' ? { code: 1, stdout: '' } : { code: 0, stdout: agyUsageJson() });
  const lim = startLimits({
    board, home: '/nowhere', now: () => NOW, timers: false, run, ompProfiles: [], claudeFile: '/nowhere/x.json',
    agyBinary: '/bin/agy',
    agyAccounts: [{ label: 'acct1', home: '/home/u', primary: true }, { label: 'acct2', home: '/home/u/.agy-acct2', primary: false }],
  });
  await lim.refresh('gemini');
  lim.dispose();
  const snap = board.snapshot().limits.gemini;
  assert.strictEqual(snap.status, 'ok');
  const first = snap.accounts.filter(a => a.name === 'AGY acct1');
  assert.strictEqual(first.length, 2, 'the working account keeps both group rows');
  assert.ok(first.every(a => a.windows.length === 2));
  const failed = snap.accounts.filter(a => a.name === 'AGY acct2');
  assert.strictEqual(failed.length, 1, 'the failed account gets one no-data row');
  assert.deepStrictEqual(failed[0].windows, []);
  assert.strictEqual(failed[0].error, 'no answer');
});
