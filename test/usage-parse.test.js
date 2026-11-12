'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { claudeUsage, ompUsage, codexRolloutUsage, codexLogUsage } = require('../lib/usage/parse');

const AT = '2026-11-12T10:00:00.000Z';

function claudeEvent(id, usage, extra) {
  return {
    type: 'assistant',
    timestamp: AT,
    message: { id, model: 'claude-opus-5-5', usage, ...extra },
  };
}

test('usage-parse: claude reply split over three lines counts once; cache 5m/1h priced apart', () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 3000,
    cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 },
  };
  const state = { seen: new Set() };
  const first = claudeUsage(claudeEvent('msg-1', usage), state);
  assert.ok(first, 'the first line of the reply yields a record');
  assert.strictEqual(claudeUsage(claudeEvent('msg-1', usage), state), null, 'the same message id is dropped');
  assert.strictEqual(claudeUsage(claudeEvent('msg-1', usage), state), null, 'and stays dropped on the third line');
  assert.strictEqual(first.provider, 'claude');
  assert.strictEqual(first.input, 1000);
  assert.strictEqual(first.cacheRead, 3000);
  assert.strictEqual(first.cacheWrite5m, 100);
  assert.strictEqual(first.cacheWrite1h, 400);
  assert.strictEqual(first.output, 200);

  // opus-5-5: input 4, output 20, cache read .2, 5m write 5, 1h write 8 per 1M.
  const split = claudeUsage(claudeEvent('msg-2', {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  }), { seen: new Set() });
  assert.ok(split);
  assert.ok(Math.abs(split.cost - (4 + 5 + 8)) < 1e-9, `5m and 1h writes are priced apart, got ${split.cost}`);

  const oldStyle = claudeUsage(claudeEvent('msg-3', {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
  }), { seen: new Set() });
  assert.ok(oldStyle);
  assert.strictEqual(oldStyle.cacheWrite5m, 1_000_000, 'no split means every write is a 5m write');
  assert.strictEqual(oldStyle.cacheWrite1h, 0);
  assert.ok(Math.abs(oldStyle.cost - 5) < 1e-9);

  const unknown = claudeUsage(claudeEvent('msg-4', { input_tokens: 1234, output_tokens: 0 }, { model: 'claude-unknown-9' }), { seen: new Set() });
  assert.ok(unknown, 'an unknown model still records tokens');
  assert.strictEqual(unknown.cost, 0);
  assert.strictEqual(unknown.input, 1234);

  assert.strictEqual(claudeUsage(claudeEvent('msg-5', usage, { model: '<synthetic>' }), { seen: new Set() }), null, 'synthetic replies are skipped');
  const record = claudeUsage(claudeEvent('msg-6', usage), { seen: new Set() });
  assert.ok(!('text' in record) && !('content' in record), 'no reply text leaves the parser');
});

test('usage-parse: omp, codex rollout and codex log records', () => {
  const omp = ompUsage({
    type: 'message',
    id: 'omp-msg-1',
    timestamp: AT,
    message: {
      role: 'assistant',
      model: 'muse-spark-1.3',
      usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300, cost: { total: 0.42 } },
    },
  }, { file: '/home/user/demo/session.jsonl' });
  assert.ok(omp);
  assert.strictEqual(omp.provider, 'omp');
  assert.strictEqual(omp.input, 1000);
  assert.strictEqual(omp.cacheRead, 2000);
  assert.strictEqual(omp.cacheWrite5m, 300);
  assert.strictEqual(omp.output, 500);
  assert.strictEqual(omp.cost, 0.42);
  assert.strictEqual(omp.key, 'omp:omp-msg-1:/home/user/demo/session.jsonl');

  const rollout = {};
  assert.strictEqual(codexRolloutUsage({
    type: 'turn_context',
    timestamp: AT,
    payload: { turn_id: 'turn-1' },
  }, rollout), null, 'turn_context only remembers the turn');
  assert.strictEqual(rollout.turnId, 'turn-1');
  const codex = codexRolloutUsage({
    type: 'event_msg',
    timestamp: AT,
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } },
    },
  }, rollout);
  assert.ok(codex);
  assert.strictEqual(codex.input, 600, 'cached tokens are split out of input');
  assert.strictEqual(codex.cacheRead, 400);
  assert.strictEqual(codex.output, 100);
  assert.strictEqual(codex.turnId, 'turn-1');
  assert.strictEqual(codex.rough, false);
  // codex-default: input 1.25, cached 0.125, output 10 per 1M.
  assert.ok(Math.abs(codex.cost - (600 * 1.25 + 400 * 0.125 + 100 * 10) / 1e6) < 1e-12);

  const thread = {};
  const first = codexLogUsage({ id: 10, ts: 1_700_000_000, usage_part: 'total_usage_tokens=1000' }, thread);
  assert.ok(first);
  assert.strictEqual(first.input, 1000);
  assert.strictEqual(first.rough, true, 'the live log estimate is rough');
  assert.ok(Math.abs(first.cost - (1000 * 1.25) / 1e6) < 1e-12);
  const second = codexLogUsage({
    id: 11,
    ts: 1_700_000_005,
    usage_part: 'total_usage_tokens=1500',
    usage_turn: 'post sampling token usage turn_id=00000000-0000-0000-0000-000000000001',
  }, thread);
  assert.ok(second);
  assert.strictEqual(second.cacheRead, 1000, 'the previous total is priced as cache reads');
  assert.strictEqual(second.output, 500, 'only the growth is new output');
  assert.strictEqual(second.turnId, '00000000-0000-0000-0000-000000000001');
  assert.ok(Math.abs(second.cost - (1000 * 0.125 + 500 * 10) / 1e6) < 1e-12);
  assert.strictEqual(codexLogUsage({ id: 12, ts: 1_700_000_010, usage_part: 'nothing here' }, thread), null);
});
