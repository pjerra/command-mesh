const { test } = require('node:test');
const assert = require('node:assert');
const { claudeCost, codexCost, CLAUDE_PRICING, CODEX_PRICING } = require('../lib/prices');

const near = (actual, expected, label) => assert.ok(
  Math.abs(actual - expected) < 1e-12,
  `${label}: expected ${expected}, got ${actual}`,
);

test('prices: claude cost of a known usage block for opus-5-5 and for an unknown model', () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_read_input_tokens: 10000,
    cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
  };
  // opus-5-5: 1000*4 + 2000*20 + 10000*0.20 + 2000*5 + 1000*8, all per 1M tokens.
  near(claudeCost('claude-opus-5-5-20260101', usage), 0.064, 'opus-5-5');
  // The longest prefix wins: opus-5-5, not opus-5.
  near(claudeCost('claude-opus-5-5', { input_tokens: 1_000_000 }), 4, 'opus-5-5 input only');
  near(claudeCost('claude-opus-5', { input_tokens: 1_000_000 }), 5, 'opus-5 input only');
  assert.strictEqual(claudeCost('claude-nope-9', usage), null, 'unknown model has no cost');
  assert.strictEqual(claudeCost('', usage), null, 'empty model has no cost');
  assert.ok(CLAUDE_PRICING.length >= 9, 'the claude table is exported');
});

test('prices: codex prices the three billed buckets at its list prices', () => {
  // 1M uncached input, 200k cached input, 100k output.
  near(codexCost({ input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 100_000 }), 2.275, 'codex');
  near(codexCost({}), 0, 'empty usage costs nothing');
  assert.strictEqual(CODEX_PRICING['codex-default'].input, 1.25, 'codex table stays editable');
});
