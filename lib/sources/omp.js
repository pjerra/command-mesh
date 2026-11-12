'use strict';

const fs = require('fs');
const path = require('path');
const { at, projectOf, allowed, touch, classify, shortLabel } = require('./shared');

const provider = 'omp';

function root(home) {
  return path.join(home, '.omp', 'agent', 'sessions');
}

// omp keeps one session folder per profile (`omp --profile go2` writes under profiles/go2), so the
// default folder alone misses every session started with a profile.
function roots(home) {
  const list = [root(home)];
  const profiles = path.join(home, '.omp', 'profiles');
  try {
    for (const item of fs.readdirSync(profiles, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory()) list.push(path.join(profiles, item.name, 'agent', 'sessions'));
    }
  } catch {
    // No profiles folder: only the default one.
  }
  return list;
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
    if (stop !== undefined && stop !== null && stop !== 'toolUse' && session.openTurn && time.record && allowed(ctx, session)) {
      ctx.board.finish(session.openTurn, stop === 'error' ? 'err' : 'ok', time.at);
      session.openTurn = undefined;
      touch(ctx, 'omp', session);
    }
    return;
  }

  if (role === 'toolResult') {
    if (!time.record || !allowed(ctx, session)) return;
    ctx.board.finish(`omp-tool-${String(message.toolCallId || '').slice(0, 80)}`, message.isError ? 'err' : 'ok', time.at);
    touch(ctx, 'omp', session);
  }
}

module.exports = { provider, root, roots, handle };
