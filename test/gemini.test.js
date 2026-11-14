const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createBoard } = require('../lib/board');
const gemini = require('../lib/sources/gemini');
const { geminiUsage } = require('../lib/usage/parse');

const NOW = Date.parse('2026-11-14T10:00:00Z');
const iso = ms => new Date(ms).toISOString();

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-gemini-'));
  fs.mkdirSync(path.join(home, '.gemini', 'tmp', 'proj', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'projects.json'), JSON.stringify({ projects: { '/work/proj': 'proj' } }));
  let t = NOW;
  const board = createBoard({ now: () => t });
  const ctx = { board, now: () => t, only: '' };
  const session = { file: path.join(home, '.gemini', 'tmp', 'proj', 'chats', 'session-2026-11-14T10-00-abcdef12.jsonl') };
  return { ctx, session, board, tick: ms => { t += ms; } };
}

test('gemini: a turn, a tool call finished on a later rewrite, the model and the project', () => {
  const { ctx, session, board, tick } = setup();
  gemini.handle(ctx, session, { sessionId: 'abcdef12-0000-4000-8000-000000000001', projectHash: 'h', startTime: iso(NOW), kind: 'main' });
  gemini.handle(ctx, session, { id: 'u1', timestamp: iso(NOW), type: 'user', content: [{ text: 'secret prompt' }] });
  const call = { id: 'c1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'executing', timestamp: iso(NOW) };
  gemini.handle(ctx, session, { id: 'g1', timestamp: iso(NOW), type: 'gemini', content: '', model: 'gemini-4-argon', toolCalls: [call] });
  // The same record again, now with a status: the tool finishes once and is not added twice.
  tick(5000);
  gemini.handle(ctx, session, { id: 'g1', timestamp: iso(NOW), type: 'gemini', content: '', model: 'gemini-4-argon', toolCalls: [{ ...call, status: 'success' }] });
  gemini.handle(ctx, session, { id: 'g1', timestamp: iso(NOW), type: 'gemini', content: '', model: 'gemini-4-argon', toolCalls: [{ ...call, status: 'success' }] });
  gemini.handle(ctx, session, { id: 'g2', timestamp: iso(NOW + 5000), type: 'gemini', content: 'done', model: 'gemini-4-argon' });

  const snap = board.snapshot();
  const mine = snap.entries.filter(e => e.provider === 'gemini');
  const tools = mine.filter(e => e.station === 'shell');
  assert.strictEqual(tools.length, 1, 'one shell entry for the call');
  assert.strictEqual(tools[0].status, 'ok');
  assert.strictEqual(tools[0].label.includes('secret'), false);
  const turn = mine.find(e => e.station === 'model');
  assert.strictEqual(turn.status, 'ok', 'the text reply ends the turn');
  assert.strictEqual(turn.project, 'proj', 'the project comes from projects.json');
  assert.ok(mine.find(e => e.station === 'you'));
  assert.deepStrictEqual(snap.modelsInUse.gemini.map(x => x.model), ['gemini-4-argon']);
  assert.ok(!JSON.stringify(snap).includes('secret prompt'), 'no prompt text reaches the board');
});

test('gemini: Gemini tool names land on the right station; files outside chats/ are ignored', () => {
  const { ctx, session, board } = setup();
  gemini.handle(ctx, session, { id: 'g1', timestamp: iso(NOW), type: 'gemini', content: '', toolCalls: [
    { id: 'a', name: 'replace', args: { file_path: '/work/proj/x.js' }, status: 'executing' },
    { id: 'b', name: 'google_web_search', args: {}, status: 'executing' },
    { id: 'c', name: 'save_memory', args: {}, status: 'executing' },
  ] });
  const stations = board.snapshot().entries.map(e => e.station).sort();
  assert.deepStrictEqual(stations, ['files', 'memory', 'web']);

  const other = { file: session.file.replace(`${path.sep}chats${path.sep}`, `${path.sep}logs${path.sep}`) };
  gemini.handle(ctx, other, { id: 'u9', timestamp: iso(NOW), type: 'user', content: 'x' });
  assert.strictEqual(board.snapshot().entries.length, 3);
});

test('gemini usage: counted once, on the first line with tokens; cached split out; cost 0', () => {
  const state = {};
  const base = { id: 'g1', timestamp: iso(NOW), type: 'gemini', model: 'gemini-4-argon' };
  assert.strictEqual(geminiUsage(base, state), null, 'no tokens yet');
  const tokens = { input: 1000, output: 200, cached: 600, thoughts: 50, tool: 0, total: 1250 };
  const record = geminiUsage({ ...base, tokens }, state);
  assert.deepStrictEqual(
    { input: record.input, cacheRead: record.cacheRead, output: record.output, cost: record.cost, provider: record.provider },
    { input: 400, cacheRead: 600, output: 250, cost: 0, provider: 'gemini' },
  );
  assert.strictEqual(geminiUsage({ ...base, tokens }, state), null, 'the rewritten reply is not counted again');
});
