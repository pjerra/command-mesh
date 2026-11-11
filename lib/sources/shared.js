'use strict';

const path = require('path');
const { classify, shortLabel, classifyCodexTool, codexToolLabel } = require('../classify');
const RECORD_MS = 120e3;
const FUTURE_MS = 5e3;
function at(session, event, now) {
  const ms = Date.parse(event && event.timestamp ? event.timestamp : '');
  if (Number.isFinite(ms)) {
    if (now() - ms > RECORD_MS) return { at: ms, record: false };
    if (ms - now() > FUTURE_MS) return { at: now(), record: true };
    return { at: ms, record: true };
  }
  return { at: now(), record: true };
}

function projectOf(session) {
  return path.basename(session.cwd || '') || 'unknown';
}

function allowed(ctx, session) {
  return !ctx.only || String(session.cwd || '').startsWith(ctx.only);
}

function touch(ctx, provider, session) {
  if (!session.key) session.key = session.file;
  ctx.board.touch(provider, session.key);
}

module.exports = { at, projectOf, allowed, touch, classify, shortLabel, classifyCodexTool, codexToolLabel };
