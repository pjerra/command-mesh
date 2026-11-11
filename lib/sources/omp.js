'use strict';

const path = require('path');
const { at, projectOf, allowed, touch, classify, shortLabel } = require('./shared');

const provider = 'omp';

function root(home) {
  return path.join(home, '.omp', 'agent', 'sessions');
}

function handle(ctx, session, event) {
  if (!event || typeof event !== 'object') return;
  if (!session.key) session.key = session.file;
  const time = at(session, event, ctx.now);

  if (event.type === 'session') {
    if (typeof event.cwd === 'string' && event.cwd) session.cwd = event.cwd;
    if (typeof event.id === 'string' && event.id) session.key = event.id;
    return;
  }

  if (event.type === 'model_change') {
    if (typeof event.model === 'string' && event.model) ctx.board.setModel('omp', event.model);
    return;
  }

  if (event.type !== 'message') return;
  const message = event.message || {};
  const role = message.role;

  if (role === 'user') {
    if (!time.record || !allowed(ctx, session)) return;
    const project = projectOf(session);
    const key = String(session.key || session.file || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(-60) || 's';
    if (session.openTurn) ctx.board.finish(session.openTurn, 'ok', time.at);
    const youId = `omp-you-${key}-${event.id}`;
    const turnId = `omp-turn-${key}-${event.id}`;
    ctx.board.add({
      id: youId,
      provider: 'omp',
      station: 'you',
      label: 'new message',
      status: 'ok',
      startedAt: time.at,
      endedAt: time.at,
      project,
      detail: { kind: 'OMP prompt', project, session: String(session.key || '') },
    });
    ctx.board.add({
      id: turnId,
      provider: 'omp',
      station: 'model',
      label: 'OMP working',
      status: 'run',
      startedAt: time.at,
      project,
      detail: { kind: 'OMP turn', project, session: String(session.key || '') },
    });
    session.openTurn = turnId;
    touch(ctx, 'omp', session);
    return;
  }

  if (role === 'assistant') {
    if (typeof message.model === 'string' && message.model) ctx.board.setModel('omp', message.model);
    const total = message.usage && message.usage.cost && message.usage.cost.total;
    if (typeof total === 'number') ctx.board.addCost('omp', total);
    if (!time.record || !allowed(ctx, session)) return;
    const project = projectOf(session);
    const blocks = message.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (!block || block.type !== 'toolCall') continue;
        const tool = String(block.name || 'tool');
        const station = classify(tool, block.arguments);
        ctx.board.add({
          id: `omp-tool-${String(block.id || '').slice(0, 80)}`,
          provider: 'omp',
          station,
          label: shortLabel(tool, block.arguments),
          status: 'run',
          startedAt: time.at,
          project,
          detail: { kind: 'OMP tool', tool, project, session: String(session.key || '') },
        });
      }
      touch(ctx, 'omp', session);
    }
    const stop = message.stopReason;
    if (stop !== undefined && stop !== null && stop !== 'toolUse' && session.openTurn) {
      ctx.board.finish(session.openTurn, stop === 'error' ? 'err' : 'ok', time.at);
      session.openTurn = undefined;
    }
    return;
  }

  if (role === 'toolResult') {
    if (!time.record || !allowed(ctx, session)) return;
    ctx.board.finish(`omp-tool-${String(message.toolCallId || '').slice(0, 80)}`, message.isError ? 'err' : 'ok', time.at);
    touch(ctx, 'omp', session);
  }
}

module.exports = { provider, root, handle };
