'use strict';

// USD per 1M tokens.
// Claude: claude-api pricing reference via the owner's status line table (2026-11-03). Cache: 5m write 1.25x input, 1h write 2x, read as listed.
const CLAUDE_PRICING = [
  // Fable / Mythos 5.2 and the Sonnet 5.5 cache-read price: claude-api skill model table (cached 2026-11-03).
  { prefix: 'claude-fable-5-2', input: 8, output: 40, cache_w_5m: 10, cache_w_1h: 16, cache_read: 0.2 },
  { prefix: 'claude-mythos-5-2', input: 8, output: 40, cache_w_5m: 10, cache_w_1h: 16, cache_read: 0.2 },
  { prefix: 'claude-fable-5-1', input: 10, output: 50, cache_w_5m: 12.5, cache_w_1h: 20, cache_read: 0.25 },
  { prefix: 'claude-mythos-5-1', input: 10, output: 50, cache_w_5m: 12.5, cache_w_1h: 20, cache_read: 0.25 },
  { prefix: 'claude-opus-5-5', input: 4, output: 20, cache_w_5m: 5, cache_w_1h: 8, cache_read: 0.2 },
  { prefix: 'claude-sonnet-5-5', input: 2, output: 10, cache_w_5m: 2.5, cache_w_1h: 4, cache_read: 0.1 },
  { prefix: 'claude-haiku-5-5', input: 0.1, output: 0.5, cache_w_5m: 0.125, cache_w_1h: 0.2, cache_read: 0.01 },
  { prefix: 'claude-fable-5', input: 10, output: 50, cache_w_5m: 12.5, cache_w_1h: 20, cache_read: 1 },
  { prefix: 'claude-mythos-5', input: 10, output: 50, cache_w_5m: 12.5, cache_w_1h: 20, cache_read: 1 },
  { prefix: 'claude-opus-5', input: 5, output: 25, cache_w_5m: 6.25, cache_w_1h: 10, cache_read: 0.5 },
  { prefix: 'claude-opus-4-8', input: 5, output: 25, cache_w_5m: 6.25, cache_w_1h: 10, cache_read: 0.5 },
  { prefix: 'claude-opus-4-7', input: 5, output: 25, cache_w_5m: 6.25, cache_w_1h: 10, cache_read: 0.5 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25, cache_w_5m: 6.25, cache_w_1h: 10, cache_read: 0.5 },
  { prefix: 'claude-opus-4-5', input: 5, output: 25, cache_w_5m: 6.25, cache_w_1h: 10, cache_read: 0.5 },
  { prefix: 'claude-opus-4-1', input: 15, output: 75, cache_w_5m: 18.75, cache_w_1h: 30, cache_read: 1.5 },
  { prefix: 'claude-opus-4-0', input: 15, output: 75, cache_w_5m: 18.75, cache_w_1h: 30, cache_read: 1.5 },
  { prefix: 'claude-sonnet-5', input: 3, output: 15, cache_w_5m: 3.75, cache_w_1h: 6, cache_read: 0.3 },
  { prefix: 'claude-sonnet-4-6', input: 3, output: 15, cache_w_5m: 3.75, cache_w_1h: 6, cache_read: 0.3 },
  { prefix: 'claude-sonnet-4-5', input: 3, output: 15, cache_w_5m: 3.75, cache_w_1h: 6, cache_read: 0.3 },
  { prefix: 'claude-sonnet-4-0', input: 3, output: 15, cache_w_5m: 3.75, cache_w_1h: 6, cache_read: 0.3 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5, cache_w_5m: 1.25, cache_w_1h: 2, cache_read: 0.1 },
];

// GPT-5 list prices, used as an estimate for whatever model Codex actually runs. Edit this entry.
const CODEX_PRICING = {
  'codex-default': { input: 1.25, cached_input: 0.125, output: 10 },
};

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function claudePrice(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return null;
  let best = null;
  for (const entry of CLAUDE_PRICING) {
    if (id.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best;
}

// usage is the `message.usage` block of a Claude assistant line. Returns null when the model is
// not in the table (nothing to price).
function claudeCost(model, usage) {
  const price = claudePrice(model);
  if (!price) return null;
  const u = usage && typeof usage === 'object' ? usage : {};
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  const read = count(u.cache_read_input_tokens);
  const create = count(u.cache_creation_input_tokens);
  const split = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const hasSplit = Boolean(split) &&
    (split.ephemeral_5m_input_tokens !== undefined || split.ephemeral_1h_input_tokens !== undefined);
  // Without the split every cache write is priced as a five minute one.
  const write5m = hasSplit ? count(split.ephemeral_5m_input_tokens) : create;
  const write1h = hasSplit ? count(split.ephemeral_1h_input_tokens) : 0;
  return (
    input * price.input +
    output * price.output +
    read * price.cache_read +
    write5m * price.cache_w_5m +
    write1h * price.cache_w_1h
  ) / 1e6;
}

// tokens: { input_tokens, cached_input_tokens, output_tokens } as separate billed buckets.
// Codex reports cached_input_tokens inside input_tokens; callers pass the uncached part as input.
function codexCost(tokens) {
  const price = CODEX_PRICING['codex-default'];
  const t = tokens && typeof tokens === 'object' ? tokens : {};
  return (
    count(t.input_tokens) * price.input +
    count(t.cached_input_tokens) * price.cached_input +
    count(t.output_tokens) * price.output
  ) / 1e6;
}

module.exports = { CLAUDE_PRICING, CODEX_PRICING, claudePrice, claudeCost, codexCost };
