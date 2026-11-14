'use strict';

// Pure parsers for the four log formats that carry token usage. Each one takes a parsed log
// event plus a small per-file state object and returns a usage record or null. No text from the
// event is ever kept: only counts, the model name and timestamps leave this module.

const { claudeCost, codexCost } = require('../prices');

// Claude repeats the same usage block on every line of one reply; the file state remembers the
// last 500 message ids so the reply is counted once.
const SEEN_CAP = 500;

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function eventTime(event) {
  const ms = Date.parse(event && typeof event.timestamp === 'string' ? event.timestamp : '');
  return Number.isFinite(ms) ? ms : null;
}

function claudeUsage(event, fileState) {
  if (!event || event.type !== 'assistant') return null;
  const message = event.message && typeof event.message === 'object' ? event.message : null;
  if (!message) return null;
  const model = typeof message.model === 'string' ? message.model : '';
  if (!model || model === '<synthetic>') return null;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;
  const at = eventTime(event);
  if (at === null) return null;

  const id = typeof message.id === 'string' ? message.id : '';
  const state = fileState && typeof fileState === 'object' ? fileState : null;
  if (state && id) {
    if (!(state.seen instanceof Set)) state.seen = new Set();
    if (state.seen.has(id)) return null;
    state.seen.add(id);
    while (state.seen.size > SEEN_CAP) state.seen.delete(state.seen.values().next().value);
  }

  const split = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const hasSplit = Boolean(split) &&
    (split.ephemeral_5m_input_tokens !== undefined || split.ephemeral_1h_input_tokens !== undefined);
  // Without the split every cache write is priced as a five minute one.
  const cacheWrite5m = hasSplit ? count(split.ephemeral_5m_input_tokens) : count(usage.cache_creation_input_tokens);
  const cacheWrite1h = hasSplit ? count(split.ephemeral_1h_input_tokens) : 0;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const priced = claudeCost(model, usage);

  return {
    provider: 'claude',
    at,
    model,
    input,
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m,
    cacheWrite1h,
    output,
    // An unknown model still counts its tokens; only the dollars are unknown.
    cost: priced === null ? 0 : priced,
    rough: false,
    key: `claude:${id || `${state && state.file ? state.file : ''}:${at}:${input}:${output}`}`,
  };
}

function ompUsage(event, fileState) {
  if (!event || event.type !== 'message') return null;
  const message = event.message && typeof event.message === 'object' ? event.message : null;
  if (!message || message.role !== 'assistant') return null;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;
  const at = eventTime(event);
  if (at === null) return null;
  const total = usage.cost && typeof usage.cost === 'object' ? Number(usage.cost.total) : NaN;
  const file = fileState && typeof fileState.file === 'string' ? fileState.file : '';
  return {
    provider: 'omp',
    at,
    model: typeof message.model === 'string' ? message.model : '',
    input: count(usage.input),
    cacheRead: count(usage.cacheRead),
    // omp reports one cache write bucket; it is priced as a five minute one.
    cacheWrite5m: count(usage.cacheWrite),
    cacheWrite1h: 0,
    output: count(usage.output),
    cost: Number.isFinite(total) && total > 0 ? total : 0,
    rough: false,
    key: `omp:${event.id === undefined ? '' : String(event.id)}:${file}`,
  };
}

// Gemini CLI writes a reply again when its tokens arrive; the reply is counted once, on the first
// line that carries tokens. promptTokenCount includes the cached part, so it is split out. The
// Gemini plan is a subscription: tokens are counted, the cost stays 0.
function geminiUsage(event, fileState) {
  if (!event || event.type !== 'gemini' || typeof event.id !== 'string') return null;
  const tokens = event.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const at = eventTime(event);
  if (at === null) return null;
  const state = fileState && typeof fileState === 'object' ? fileState : null;
  if (state) {
    if (!(state.seen instanceof Set)) state.seen = new Set();
    if (state.seen.has(event.id)) return null;
    state.seen.add(event.id);
    while (state.seen.size > SEEN_CAP) state.seen.delete(state.seen.values().next().value);
  }
  const cached = count(tokens.cached);
  return {
    provider: 'gemini',
    at,
    model: typeof event.model === 'string' ? event.model : '',
    input: Math.max(0, count(tokens.input) - cached),
    cacheRead: cached,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: count(tokens.output) + count(tokens.thoughts),
    cost: 0,
    rough: false,
    key: `gemini:${event.id}`,
  };
}

// Codex rollouts write a turn_context (or task_started) before the token counts of that turn, so
// the parser remembers the newest turn id in the file state and attaches it to each usage record.
function codexRolloutUsage(event, fileState) {
  if (!event || typeof event !== 'object') return null;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const state = fileState && typeof fileState === 'object' ? fileState : {};

  if (event.type === 'turn_context' || (event.type === 'event_msg' && payload.type === 'task_started')) {
    const id = payload.turn_id || payload.root_turn_id || (payload.info && payload.info.turn_id);
    if (typeof id === 'string' && id) state.turnId = id;
    return null;
  }
  if (event.type !== 'event_msg' || payload.type !== 'token_count') return null;

  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  const last = info.last_token_usage;
  if (!last || typeof last !== 'object') return null;
  const at = eventTime(event);
  if (at === null) return null;

  const cached = count(last.cached_input_tokens);
  // Codex reports cached tokens inside input_tokens; the price table bills them apart.
  const input = Math.max(0, count(last.input_tokens) - cached);
  const output = count(last.output_tokens);
  const turnId = payload.turn_id || info.turn_id || state.turnId || '';

  return {
    provider: 'codex',
    at,
    model: typeof payload.model === 'string' ? payload.model : '',
    input,
    cacheRead: cached,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output,
    cost: codexCost({ input_tokens: input, cached_input_tokens: cached, output_tokens: output }),
    rough: false,
    key: `codex:${turnId}:${at}:${input}:${output}`,
    turnId: typeof turnId === 'string' ? turnId : '',
  };
}

// The live Codex debug log has no per-turn token counts, only the growing total_usage_tokens of a
// thread. This keeps the old estimate: the first row prices the whole total as input tokens, each
// later row prices the previous total as cache reads and the growth as output.
function codexLogUsage(row, threadState) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.usage_part !== 'string' || !row.usage_part) return null;
  const match = /total_usage_tokens=(\d+)/.exec(row.usage_part);
  if (!match) return null;
  const at = Number(row.ts) * 1000;
  if (!Number.isFinite(at)) return null;
  const total = Number(match[1]);
  if (!Number.isFinite(total) || total < 0) return null;

  const state = threadState && typeof threadState === 'object' ? threadState : {};
  const previous = state.lastTotal;
  let input = 0;
  let cacheRead = 0;
  let output = 0;
  let cost;
  if (previous === undefined) {
    input = total;
    cost = codexCost({ input_tokens: total, cached_input_tokens: 0, output_tokens: 0 });
  } else {
    cacheRead = previous;
    output = Math.max(0, total - previous);
    cost = codexCost({ input_tokens: 0, cached_input_tokens: cacheRead, output_tokens: output });
  }
  state.lastTotal = total;

  let turnId = '';
  if (typeof row.usage_turn === 'string') {
    const turn = /turn_id=([0-9a-f-]{36})/.exec(row.usage_turn);
    if (turn) turnId = turn[1];
  }
  return {
    provider: 'codex',
    at,
    model: typeof state.model === 'string' ? state.model : '',
    input,
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output,
    cost,
    rough: true,
    key: `codex-log:${row.id}`,
    turnId,
  };
}

module.exports = { claudeUsage, ompUsage, codexRolloutUsage, codexLogUsage, geminiUsage };
