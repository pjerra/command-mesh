const fs = require('fs');
const path = require('path');
const { at, projectOf, allowed, touch } = require('./shared');
const { classifyCodexTool, codexToolLabel } = require('../classify');

const provider = 'codex';

// A second login runs the same CLI with its own CODEX_HOME: <home>/.codex-acct2, which holds its
// own sessions/ and logs_<N>.sqlite. Only that folder is read; it is not a symlink mirror like the
// Antigravity profile homes, so nothing under the real home is reached twice. Sessions from it
// carry the account and are keyed by account plus id.
const ACCOUNT_HOME = '.codex-acct2';
const ACCOUNT_PATH = /[\\/]\.codex-acct2[\\/]/;
const ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function root(home) {
  return path.join(home, '.codex', 'sessions');
}

// The second CODEX_HOME, when that folder exists.
function accountHome(home) {
  const dir = path.join(home, ACCOUNT_HOME);
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function roots(home) {
  const out = [root(home)];
  const second = accountHome(home);
  if (second) out.push(path.join(second, 'sessions'));
  return out;
}

function accountOf(file) {
  return ACCOUNT_PATH.test(String(file || '')) ? 'acct2' : '';
}

// The board and the usage ledger keep one session per account: account 1 keys by the session id
// alone, account 2 prefixes its own.
function sessionKeyOf(file, id = '') {
  let base = String(id || '');
  if (!base) {
    const match = ROLLOUT_ID.exec(path.basename(String(file || '')).replace(/\.jsonl$/i, ''));
    base = match ? match[1] : '';
  }
  if (!base) return '';
  const account = accountOf(file);
  return account ? `${account}:${base}` : base;
}

function handle(ctx, session, event) {
  if (!event || typeof event !== 'object') return;
  if (!session.key) session.key = session.file;
  const account = accountOf(session.file);
  const payload = event.payload || {};
  const time = at(session, event, ctx.now);

  if (event.type === 'turn_context') {
    if (typeof payload.cwd === 'string' && payload.cwd) session.cwd = payload.cwd;
    if (typeof payload.model === 'string' && payload.model) ctx.board.setModel('codex', payload.model, time.at, session.key);
    return;
  }

  if (event.type === 'session_meta') {
    if (payload.payload && typeof payload.payload.cwd === 'string' && payload.payload.cwd) {
      session.cwd = payload.payload.cwd;
    } else if (typeof payload.cwd === 'string' && payload.cwd) {
      session.cwd = payload.cwd;
    }
    const id = (payload.payload && payload.payload.id) || payload.id;
    if (typeof id === 'string' && id) session.key = sessionKeyOf(session.file, id);
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
      detail: { kind: 'ChatGPT / Codex turn', project, session: sessionName, account },
    });
    ctx.board.add({
      id: `codex-turn-${turnId}`,
      provider: 'codex',
      station: 'model',
      label: 'Codex working',
      status: 'run',
      startedAt: time.at,
      project,
      detail: { kind: 'ChatGPT / Codex turn', project, session: sessionName, account },
    });
    touch(ctx, 'codex', session);
    return;
  }

  if (event.type === 'event_msg' && payload.type === 'token_count') {
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
      detail: { kind: 'Codex tool call', tool, project, session: sessionName, account },
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

module.exports = { provider, root, roots, accountHome, accountOf, sessionKeyOf, handle };
