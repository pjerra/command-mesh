'use strict';

const path = require('path');
const { at, projectOf, allowed, touch, classify, shortLabel } = require('./shared');

const provider = 'claude';

function root(home) {
  return path.join(home, '.claude', 'projects');
}

function handle(ctx, session, event) {
  if (!event || typeof event !== 'object') return;
  if (typeof event.cwd === 'string' && event.cwd) session.cwd = event.cwd;
  if (typeof event.sessionId === 'string' && event.sessionId) session.key = event.sessionId;
  else if (!session.key) session.key = session.file;
  if (String(session.file || '').includes('/subagents/')) session.subagent = true;
  const time = at(session, event, ctx.now);
  if (session.fresh && !session.memRecorded) {
    session.memRecorded = true;
    if (time.record && allowed(ctx, session)) recordMemory(ctx, session, time.at, 'memory loaded', `claude-mem-${session.key || session.file}`, event);
  }

  if (event.type === 'assistant') {
    const message = event.message || {};
    const model = message.model;
    if (typeof model === 'string' && model && model !== '<synthetic>') {
      session.model = model;
      ctx.board.setModel('claude', model, time.at, session.key);
    }
    if (!time.record || !allowed(ctx, session)) return;
    const blocks = message.content;
    if (Array.isArray(blocks)) {
      const project = projectOf(session);
      const sessionId = event.sessionId || '';
      for (const block of blocks) {
        if (!block || block.type !== 'tool_use') continue;
        const tool = String(block.name || 'tool');
        const station = classify(tool, block.input);
        ctx.board.add({
          id: `claude-tool-${block.id}`,
          provider: 'claude',
          station,
          label: shortLabel(tool, block.input),
          status: 'run',
          startedAt: time.at,
          project,
          detail: {
            kind: event.isSidechain ? 'Claude subagent tool' : 'Claude tool',
            subagent: Boolean(session.subagent || event.isSidechain),
            tool,
            project,
            session: sessionId,
          },
        });
      }
      if (time.record && allowed(ctx, session)) touch(ctx, 'claude', session);
    }
    if (message.stop_reason === 'end_turn' && !event.isSidechain && session.openTurn && time.record && allowed(ctx, session)) {
      ctx.board.finish(session.openTurn, 'ok', time.at);
      session.openTurn = undefined;
      touch(ctx, 'claude', session);
    }
    return;
  }

  if (event.type === 'user') {
    const message = event.message || {};
    const content = message.content;
    if (Array.isArray(content)) {
      const results = content.filter(b => b && b.type === 'tool_result');
      if (results.length) {
        if (!time.record || !allowed(ctx, session)) return;
        for (const block of results) {
          ctx.board.finish(`claude-tool-${block.tool_use_id}`, block.is_error ? 'err' : 'ok', time.at);
        }
        touch(ctx, 'claude', session);
        return;
      }
      if (event.isSidechain || event.isMeta) return;
      recordPrompt(ctx, session, event, time);
      return;
    }
    if (typeof content === 'string') {
      if (event.isSidechain || event.isMeta) return;
      recordPrompt(ctx, session, event, time);
    }
    return;
  }

  if (event.type === 'attachment') {
    const attachment = event.attachment || {};
    const type = String(attachment.type || '');
    if (!type.startsWith('hook_')) return;
    const hookEvent = attachment.hookEvent;
    const hookName = String(attachment.hookName || '');
    const exitCode = attachment.exitCode;
    if (hookEvent === 'SessionStart' && /compact/i.test(hookName) && time.record && allowed(ctx, session)) {
      recordMemory(ctx, session, time.at, 'memory reloaded', `claude-mem-${event.uuid}`, event);
    }
    const failed = (typeof exitCode === 'number' && exitCode !== 0) || /error/i.test(type);
    if ((hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') && !failed) return;
    if (!time.record || !allowed(ctx, session)) return;
    const project = projectOf(session);
    const sessionId = event.sessionId || '';
    ctx.board.add({
      id: `claude-hook-${event.uuid}`,
      provider: 'claude',
      station: 'hooks',
      label: String(attachment.hookName || 'hook').slice(0, 60),
      status: failed ? 'err' : 'ok',
      startedAt: time.at,
      endedAt: time.at,
      project,
      detail: { kind: 'Claude hook', subagent: Boolean(session.subagent), project, session: sessionId },
    });
    touch(ctx, 'claude', session);
    return;
  }
}

function recordMemory(ctx, session, at, label, id, event) {
  const project = projectOf(session);
  const subagent = String(session.file || '').includes('/subagents/');
  ctx.board.add({
    id,
    provider: 'claude',
    station: 'memory',
    label: subagent && label === 'memory loaded' ? 'memory loaded \u00b7 subagent' : label,
    status: 'ok',
    startedAt: at,
    endedAt: at,
    project,
    detail: { kind: 'Claude memory', subagent, project, session: event.sessionId || '' },
  });
  touch(ctx, 'claude', session);
}

function recordPrompt(ctx, session, event, time) {
  if (!time.record || !allowed(ctx, session)) return;
  const project = projectOf(session);
  const sessionId = event.sessionId || '';
  if (session.openTurn) ctx.board.finish(session.openTurn, 'ok', time.at);
  const youId = `claude-you-${event.uuid}`;
  const turnId = `claude-turn-${event.uuid}`;
  ctx.board.add({
    id: youId,
    provider: 'claude',
    station: 'you',
    label: 'new message',
    status: 'ok',
    startedAt: time.at,
    endedAt: time.at,
    project,
    detail: { kind: 'Claude prompt', subagent: Boolean(session.subagent), project, session: sessionId },
  });
  ctx.board.add({
    id: turnId,
    provider: 'claude',
    station: 'model',
    label: 'Claude working',
    status: 'run',
    startedAt: time.at,
    project,
    detail: { kind: 'Claude turn', subagent: Boolean(session.subagent), project, session: sessionId },
  });
  session.openTurn = turnId;
  touch(ctx, 'claude', session);
}

module.exports = { provider, root, handle };
