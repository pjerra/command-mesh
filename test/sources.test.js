const { test } = require('node:test');
const assert = require('node:assert');
const { createBoard } = require('../lib/board');
const claude = require('../lib/sources/claude');
const omp = require('../lib/sources/omp');
const codex = require('../lib/sources/codex');

const NOW = 1_700_000_000_000;

function ctxFor(only = '') {
  return { board: createBoard({ now: () => NOW }), now: () => NOW, only };
}
function sess(file = '/x/s.jsonl') {
  return { file, offset: 0, carry: '', cwd: '', key: file };
}
function entries(ctx) {
  return ctx.board.snapshot().entries;
}

test('claude: prompt opens a turn, tool_use runs, tool_result with is_error ends it as err, end_turn closes the turn', () => {
  const ctx = ctxFor();
  const s = sess();
  s.cwd = '/home/user/demo';
  claude.handle(ctx, s, {
    type: 'user', uuid: 'u1', sessionId: 's1', timestamp: new Date(NOW).toISOString(),
    message: { content: 'hello there' },
  });
  let list = entries(ctx);
  assert.ok(list.some(e => e.id === 'claude-you-u1' && e.station === 'you'));
  assert.ok(list.some(e => e.id === 'claude-turn-u1' && e.status === 'run'));
  claude.handle(ctx, s, {
    type: 'assistant', uuid: 'a1', sessionId: 's1', timestamp: new Date(NOW).toISOString(),
    message: {
      model: 'claude-opus-4-1',
      stop_reason: null,
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }],
    },
  });
  list = entries(ctx);
  const tool = list.find(e => e.id === 'claude-tool-t1');
  assert.ok(tool, 'tool entry recorded');
  assert.strictEqual(tool.status, 'run');
  assert.strictEqual(tool.station, 'shell');
  assert.strictEqual(tool.label, 'Bash git');
  claude.handle(ctx, s, {
    type: 'user', uuid: 'u2', sessionId: 's1', timestamp: new Date(NOW).toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
  });
  assert.strictEqual(entries(ctx).find(e => e.id === 'claude-tool-t1').status, 'err');
  claude.handle(ctx, s, {
    type: 'assistant', uuid: 'a2', sessionId: 's1', timestamp: new Date(NOW).toISOString(),
    message: { model: 'claude-opus-4-1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  });
  assert.strictEqual(entries(ctx).find(e => e.id === 'claude-turn-u1').status, 'ok');
});

test('claude: sidechain prompt is not recorded, old event (timestamp 10 min ago) is not recorded', () => {
  const ctx = ctxFor();
  const s = sess();
  s.cwd = '/home/user/demo';
  claude.handle(ctx, s, {
    type: 'user', uuid: 'side1', sessionId: 's1', isSidechain: true,
    timestamp: new Date(NOW).toISOString(),
    message: { content: 'sidechain work' },
  });
  assert.ok(!entries(ctx).some(e => e.id === 'claude-you-side1'));
  claude.handle(ctx, s, {
    type: 'user', uuid: 'old1', sessionId: 's1',
    timestamp: new Date(NOW - 10 * 60e3).toISOString(),
    message: { content: 'old prompt' },
  });
  assert.ok(!entries(ctx).some(e => e.id === 'claude-you-old1'));
});

test('claude: PreToolUse hook success is skipped, a failing hook is recorded as err', () => {
  const ctx = ctxFor();
  const s = sess();
  s.cwd = '/home/user/demo';
  claude.handle(ctx, s, {
    type: 'attachment', uuid: 'h1', timestamp: new Date(NOW).toISOString(),
    attachment: { type: 'hook_input', hookEvent: 'PreToolUse', hookName: 'lint', exitCode: 0 },
  });
  assert.ok(!entries(ctx).some(e => e.id === 'claude-hook-h1'));
  claude.handle(ctx, s, {
    type: 'attachment', uuid: 'h2', timestamp: new Date(NOW).toISOString(),
    attachment: { type: 'hook_error', hookEvent: 'PreToolUse', hookName: 'lint', exitCode: 1 },
  });
  const rec = entries(ctx).find(e => e.id === 'claude-hook-h2');
  assert.ok(rec);
  assert.strictEqual(rec.status, 'err');
  assert.strictEqual(rec.station, 'hooks');
});

test('omp: toolCall and toolResult pair up, stop closes the turn, cost is summed', () => {
  const ctx = ctxFor();
  const s = sess();
  s.key = '/home/user/.omp/agent/sessions/abc.jsonl';
  omp.handle(ctx, s, {
    type: 'session', id: 'abc', cwd: '/home/user/demo', timestamp: new Date(NOW).toISOString(),
  });
  omp.handle(ctx, s, {
    type: 'message', id: 'm1', timestamp: new Date(NOW).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'do it' }] },
  });
  assert.ok(entries(ctx).some(e => e.id.startsWith('omp-you-')));
  const turnId = entries(ctx).find(e => e.station === 'model' && e.status === 'run').id;
  omp.handle(ctx, s, {
    type: 'message', id: 'm2', timestamp: new Date(NOW).toISOString(),
    message: {
      role: 'assistant', model: 'openai/gpt-5-thinking', stopReason: null,
      usage: { cost: { total: 1.25 } },
      content: [{ type: 'toolCall', id: 'c1', name: 'Bash', arguments: { command: 'git status' } }],
    },
  });
  const toolId = entries(ctx).find(e => e.station === 'shell' && e.status === 'run').id;
  assert.ok(toolId.startsWith('omp-tool-'));
  omp.handle(ctx, s, {
    type: 'message', id: 'm3', timestamp: new Date(NOW).toISOString(),
    message: { role: 'toolResult', toolCallId: 'c1', isError: false },
  });
  assert.strictEqual(entries(ctx).find(e => e.id === toolId).status, 'ok');
  assert.strictEqual(ctx.board.snapshot().usage.omp.session, 1.25);
  omp.handle(ctx, s, {
    type: 'message', id: 'm4', timestamp: new Date(NOW).toISOString(),
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
  });
  assert.strictEqual(entries(ctx).find(e => e.id === turnId).status, 'ok');
});

test('codex: task_started, function_call, function_call_output, task_complete, with no workspace filter', () => {
  const ctx = ctxFor();
  const s = sess();
  codex.handle(ctx, s, { type: 'turn_context', timestamp: new Date(NOW).toISOString(), payload: { cwd: '/elsewhere/proj', model: 'gpt-5' } });
  codex.handle(ctx, s, {
    type: 'event_msg', timestamp: new Date(NOW).toISOString(), payload: { type: 'task_started', turn_id: 'T1' },
  });
  codex.handle(ctx, s, {
    type: 'response_item', timestamp: new Date(NOW).toISOString(),
    payload: { type: 'function_call', name: 'read', call_id: 'C1', input: '{}' },
  });
  codex.handle(ctx, s, {
    type: 'response_item', timestamp: new Date(NOW).toISOString(),
    payload: { type: 'function_call_output', call_id: 'C1' },
  });
  codex.handle(ctx, s, {
    type: 'event_msg', timestamp: new Date(NOW).toISOString(), payload: { type: 'task_complete', turn_id: 'T1' },
  });
  const list = entries(ctx);
  assert.strictEqual(list.find(e => e.id === 'codex-tool-C1').status, 'ok');
  assert.strictEqual(list.find(e => e.id === 'codex-turn-T1').status, 'ok');
});

test('only: a session outside the prefix is not recorded', () => {
  const ctx = ctxFor('/home/user/demo');
  const s = sess();
  s.cwd = '/other/place';
  claude.handle(ctx, s, {
    type: 'user', uuid: 'u9', sessionId: 's9', timestamp: new Date(NOW).toISOString(),
    message: { content: 'hi' },
  });
  assert.strictEqual(entries(ctx).length, 0);
  const s2 = sess('/y/s.jsonl');
  omp.handle({ board: ctx.board, now: ctx.now, only: '/home/user/demo' }, s2, {
    type: 'session', id: 'z', cwd: '/home/user/demo/sub', timestamp: new Date(NOW).toISOString(),
  });
  omp.handle({ board: ctx.board, now: ctx.now, only: '/home/user/demo' }, s2, {
    type: 'message', id: 'm9', timestamp: new Date(NOW).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  });
  assert.ok(entries(ctx).length > 0);
});

test('privacy: a prompt text and a bash command argument never appear in JSON.stringify(snapshot)', () => {
  const ctx = ctxFor();
  const s = sess();
  s.cwd = '/home/user/demo';
  const secret = 'supersecretprompt-' + Math.random().toString(36).slice(2);
  const cmd = 'deploy-' + Math.random().toString(36).slice(2) + ' --token hunter2';
  claude.handle(ctx, s, {
    type: 'user', uuid: 'up', sessionId: 'sp', timestamp: new Date(NOW).toISOString(),
    message: { content: secret },
  });
  claude.handle(ctx, s, {
    type: 'assistant', uuid: 'ua', sessionId: 'sp', timestamp: new Date(NOW).toISOString(),
    message: {
      model: 'm', stop_reason: null,
      content: [{ type: 'tool_use', id: 'tp', name: 'Bash', input: { command: cmd } }],
    },
  });
  const json = JSON.stringify(ctx.board.snapshot());
  assert.ok(!json.includes(secret), 'prompt text leaked');
  assert.ok(!json.includes(cmd), 'command args leaked');
  assert.ok(!json.includes('hunter2'), 'token leaked');
  claude.handle(ctx, s, {
    type: 'assistant', uuid: 'ua2', sessionId: 'sp', timestamp: new Date(NOW).toISOString(),
    message: {
      model: 'm', stop_reason: null,
      content: [{ type: 'tool_use', id: 'tq', name: 'Bash', input: { command: 'TOKEN=sk-secret-123 curl https://x' } }],
    },
  });
  const json2 = JSON.stringify(ctx.board.snapshot());
  assert.ok(!json2.includes('sk-secret-123'), 'assignment value leaked');
  assert.strictEqual(ctx.board.snapshot().entries.find(e => e.id === 'claude-tool-tq').label, 'Bash curl');
});

const near = (actual, expected, label) => assert.ok(
  Math.abs(actual - expected) < 1e-12,
  `${label}: expected ${expected}, got ${actual}`,
);

test('claude: one reply split over three lines is costed once', () => {
  const ctx = ctxFor();
  const s = sess();
  s.cwd = '/home/user/demo';
  const line = uuid => ({
    type: 'assistant', uuid, sessionId: 's1', timestamp: new Date(NOW).toISOString(),
    message: {
      id: 'msg_once', model: 'claude-opus-5-5', stop_reason: null,
      usage: { input_tokens: 1000, output_tokens: 2000 },
      content: [{ type: 'text', text: 'one block of a reply' }],
    },
  });
  claude.handle(ctx, s, line('a1'));
  claude.handle(ctx, s, line('a2'));
  claude.handle(ctx, s, line('a3'));
  assert.strictEqual(entries(ctx).length, 0, 'text-only assistant lines add no entries');
  near(ctx.board.snapshot().usage.claude.session, 0.044, 'three lines of one message costed once');
});

test('claude: cache_creation split prices 5m and 1h differently; missing split prices all as 5m', () => {
  const split = ctxFor();
  const s1 = sess('/x/one.jsonl');
  s1.cwd = '/home/user/demo';
  claude.handle(split, s1, {
    type: 'assistant', uuid: 'b1', sessionId: 's1', timestamp: new Date(NOW).toISOString(),
    message: {
      id: 'msg_split', model: 'claude-opus-5-5', stop_reason: null,
      usage: {
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 },
      },
      content: [],
    },
  });
  near(split.board.snapshot().usage.claude.session, 6.8, '400k at 5m + 600k at 1h');

  const flat = ctxFor();
  const s2 = sess('/x/two.jsonl');
  s2.cwd = '/home/user/demo';
  claude.handle(flat, s2, {
    type: 'assistant', uuid: 'b2', sessionId: 's2', timestamp: new Date(NOW).toISOString(),
    message: {
      id: 'msg_flat', model: 'claude-opus-5-5', stop_reason: null,
      usage: { cache_creation_input_tokens: 1_000_000 },
      content: [],
    },
  });
  near(flat.board.snapshot().usage.claude.session, 5, 'missing split prices every write as 5m');
});

test('codex: token_count prices last_token_usage exactly', () => {
  const ctx = ctxFor();
  const s = sess();
  s.cwd = '/home/user/demo';
  codex.handle(ctx, s, {
    type: 'event_msg', timestamp: new Date(NOW).toISOString(),
    payload: {
      type: 'token_count', turn_id: 'T-cost',
      info: {
        last_token_usage: {
          input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 100_000,
        },
      },
    },
  });
  const usage = ctx.board.snapshot().usage.codex;
  // Codex counts the cached tokens inside input_tokens, so only 800k are billed as uncached:
  // 800k*1.25 + 200k*0.125 + 100k*10, per 1M.
  near(usage.session, 2.025, 'token_count cost');
  assert.strictEqual(usage.rough, undefined, 'the rollout cost is exact, not rough');
  assert.strictEqual(ctx.board.isCosted('codex', 'T-cost'), true, 'the turn is marked as priced');
});
