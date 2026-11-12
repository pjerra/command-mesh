const path = require('path');
const { at, projectOf, allowed, touch } = require('./shared');
const { classifyCodexTool, codexToolLabel } = require('../classify');
const { codexCost } = require('../prices');

const provider = 'codex';

function root(home) {
  return path.join(home, '.codex', 'sessions');
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function handle(ctx, session, event) {
  if (!event || typeof event !== 'object') return;
  if (!session.key) session.key = session.file;
  const payload = event.payload || {};
  const time = at(session, event, ctx.now);

  if (event.type === 'turn_context') {
    if (typeof payload.cwd === 'string' && payload.cwd) session.cwd = payload.cwd;
    if (typeof payload.model === 'string' && payload.model) ctx.board.setModel('codex', payload.model);
    return;
  }

  if (event.type === 'session_meta') {
    if (payload.payload && typeof payload.payload.cwd === 'string' && payload.payload.cwd) {
      session.cwd = payload.payload.cwd;
    } else if (typeof payload.cwd === 'string' && payload.cwd) {
      session.cwd = payload.cwd;
    }
    const id = (payload.payload && payload.payload.id) || payload.id;
    if (typeof id === 'string' && id) session.key = id;
    return;
  }

  if (!time.record || !allowed(ctx, session)) return;
  const project = projectOf(session);
  const sessionName = String(session.key || '');

  if (event.type === 'event_msg' && payload.type === 'task_started') {
    const turnId = String(payload.turn_id || payload.root_turn_id || time.at);
    session.turnId = turnId;
    ctx.board.add({
      id: `codex-you-${turnId}`,
      provider: 'codex',
      station: 'you',
      label: 'new Codex message',
      status: 'ok',
      startedAt: time.at,
      endedAt: time.at,
      project,
      detail: { kind: 'ChatGPT / Codex turn', project, session: sessionName },
    });
    ctx.board.add({
      id: `codex-turn-${turnId}`,
      provider: 'codex',
      station: 'model',
      label: 'Codex working',
      status: 'run',
      startedAt: time.at,
      project,
      detail: { kind: 'ChatGPT / Codex turn', project, session: sessionName },
    });
    touch(ctx, 'codex', session);
    return;
  }

  if (event.type === 'event_msg' && payload.type === 'token_count') {
    const last = payload.info && payload.info.last_token_usage;
    if (last && typeof last === 'object') {
      const cached = count(last.cached_input_tokens);
      // Codex counts the cached tokens inside input_tokens; the price table bills them apart.
      const input = Math.max(0, count(last.input_tokens) - cached);
      ctx.board.addCost('codex', codexCost({
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: count(last.output_tokens),
      }));
    }
    const turnId = payload.turn_id || (payload.info && payload.info.turn_id) || session.turnId;
    if (turnId) ctx.board.markCosted('codex', String(turnId));
    touch(ctx, 'codex', session);
    return;
  }

  if (event.type === 'event_msg' && payload.type === 'task_complete') {
    const turnId = String(payload.turn_id || payload.root_turn_id || '');
    if (turnId) ctx.board.finish(`codex-turn-${turnId}`, 'ok', time.at);
    touch(ctx, 'codex', session);
    return;
  }

  if (event.type !== 'response_item') return;

  if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
    const tool = String(payload.name || 'tool').trim().slice(0, 80) || 'tool';
    const callId = String(payload.call_id || payload.id || time.at);
    const input = typeof payload.input === 'string' ? payload.input : '';
    const station = classifyCodexTool(tool, input);
    ctx.board.add({
      id: `codex-tool-${callId}`,
      provider: 'codex',
      station,
      label: codexToolLabel(tool, station),
      status: 'run',
      startedAt: time.at,
      project,
      detail: { kind: 'Codex tool call', tool, project, session: sessionName },
    });
    touch(ctx, 'codex', session);
    return;
  }

  if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
    const callId = String(payload.call_id || payload.id || '');
    if (callId) ctx.board.finish(`codex-tool-${callId}`, 'ok', time.at);
    touch(ctx, 'codex', session);
  }
}

module.exports = { provider, root, handle };
