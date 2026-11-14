'use strict';

// Gemini CLI sessions: ~/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl, subagents under
// chats/<parent id>/<id>.jsonl. The first line is the session metadata; then one line per message
// record. A record is written again (same id) every time it changes: tool calls gain a status and
// tokens arrive after the reply. Each message, tool call and finish is therefore handled once.
// Only names, ids, statuses and times are read; message text and tool arguments other than the
// short label never leave this module.

const fs = require('fs');
const path = require('path');
const { at, projectOf, allowed, touch, classify, shortLabel } = require('./shared');

const provider = 'gemini';
const DONE = new Set(['success', 'error', 'cancelled', 'canceled']);
const SEEN_CAP = 2000;

// Gemini tool names that the shared rules would put on the wrong station.
const STATION = {
  replace: 'files',
  list_directory: 'files',
  read_many_files: 'files',
  search_file_content: 'files',
  grep_search: 'files',
  save_memory: 'memory',
  google_web_search: 'web',
  web_fetch: 'web',
  write_todos: 'model',
};

function root(home) {
  return path.join(home, '.gemini', 'tmp');
}

// projects.json maps a project path to its folder name under tmp/.
let projectCache = { file: '', at: 0, map: new Map() };
function projectPath(home, folder) {
  const file = path.join(home, '.gemini', 'projects.json');
  const now = Date.now();
  if (projectCache.file !== file || now - projectCache.at > 30e3) {
    const map = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [dir, name] of Object.entries((data && data.projects) || {})) map.set(String(name), dir);
    } catch {
      // No projects file yet.
    }
    projectCache = { file, at: now, map };
  }
  return projectCache.map.get(folder) || '';
}

function cwdOf(session) {
  const parts = String(session.file || '').split(path.sep);
  const tmp = parts.lastIndexOf('tmp');
  if (tmp < 1 || parts[tmp - 1] !== '.gemini') return '';
  const home = parts.slice(0, tmp - 1).join(path.sep) || path.sep;
  return projectPath(home, parts[tmp + 1] || '');
}

function remember(set, id) {
  set.add(id);
  if (set.size > SEEN_CAP) set.delete(set.values().next().value);
}

function stationOf(name, args) {
  return STATION[String(name || '').toLowerCase()] || classify(name, args);
}

function handle(ctx, session, event) {
  if (!event || typeof event !== 'object') return;
  if (!String(session.file || '').includes(`${path.sep}chats${path.sep}`)) return;
  if (!session.key) session.key = session.file;
  if (!session.gemini) {
    session.gemini = { messages: new Set(), tools: new Set(), finished: new Set() };
    if (!session.cwd) session.cwd = cwdOf(session);
  }
  const seen = session.gemini;

  // Metadata line: the session id is the key the rest of the dashboard uses.
  if (typeof event.sessionId === 'string' && event.sessionId && event.projectHash !== undefined && !event.type) {
    session.key = event.sessionId;
    if (Array.isArray(event.directories) && typeof event.directories[0] === 'string' && !session.cwd) {
      session.cwd = event.directories[0];
    }
    return;
  }
  if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') return;

  const time = at(session, event, ctx.now);
  const key = String(session.key || session.file || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(-60) || 's';
  const first = !seen.messages.has(event.id);
  if (first) remember(seen.messages, event.id);

  if (event.type === 'user') {
    if (!first || !time.record || !allowed(ctx, session)) return;
    const project = projectOf(session);
    if (session.openTurn) ctx.board.finish(session.openTurn, 'ok', time.at);
    const turnId = `gemini-turn-${key}-${event.id}`;
    ctx.board.add({
      id: `gemini-you-${key}-${event.id}`,
      provider,
      station: 'you',
      label: 'new message',
      status: 'ok',
      startedAt: time.at,
      endedAt: time.at,
      project,
      detail: { kind: 'Gemini prompt', project, session: String(session.key || '') },
    });
    ctx.board.add({
      id: turnId,
      provider,
      station: 'model',
      label: 'Gemini working',
      status: 'run',
      startedAt: time.at,
      project,
      detail: { kind: 'Gemini turn', project, session: String(session.key || '') },
    });
    session.openTurn = turnId;
    touch(ctx, provider, session);
    return;
  }

  if (event.type === 'error') {
    if (!first || !time.record || !allowed(ctx, session)) return;
    if (session.openTurn) {
      ctx.board.finish(session.openTurn, 'err', time.at);
      session.openTurn = undefined;
    }
    touch(ctx, provider, session);
    return;
  }

  if (event.type !== 'gemini') return;
  if (typeof event.model === 'string' && event.model) ctx.board.setModel(provider, event.model, time.at, session.key);
  if (!allowed(ctx, session)) return;
  const project = projectOf(session);
  const calls = Array.isArray(event.toolCalls) ? event.toolCalls : [];
  let pending = 0;
  for (const call of calls) {
    if (!call || typeof call.id !== 'string' || !call.id) continue;
    const id = `gemini-tool-${call.id.slice(0, 80)}`;
    const status = String(call.status || '').toLowerCase();
    const done = DONE.has(status);
    if (!seen.tools.has(call.id)) {
      remember(seen.tools, call.id);
      const callTime = at(session, { timestamp: call.timestamp || event.timestamp }, ctx.now);
      if (callTime.record) {
        const name = String(call.name || 'tool');
        ctx.board.add({
          id,
          provider,
          station: stationOf(name, call.args),
          label: shortLabel(name, call.args),
          status: 'run',
          startedAt: callTime.at,
          project,
          detail: { kind: 'Gemini tool', tool: name, project, session: String(session.key || '') },
        });
      }
    }
    if (done && !seen.finished.has(call.id)) {
      remember(seen.finished, call.id);
      // A finish line is new even when the call itself started long ago.
      ctx.board.finish(id, status === 'error' ? 'err' : 'ok', ctx.now());
    }
    if (!done) pending++;
  }
  if (calls.length) touch(ctx, provider, session);

  // A reply with text and no running tools ends the turn.
  const text = typeof event.content === 'string' ? event.content.trim() : Array.isArray(event.content) && event.content.length;
  if (text && !pending && !calls.length && session.openTurn && (time.record || !first)) {
    ctx.board.finish(session.openTurn, 'ok', first ? time.at : ctx.now());
    session.openTurn = undefined;
    touch(ctx, provider, session);
  }
}

module.exports = { provider, root, handle, cwdOf };
