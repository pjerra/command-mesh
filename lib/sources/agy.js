'use strict';

// Antigravity CLI (agy) sessions, shown under the same blue core as Gemini CLI (provider
// 'gemini'). agy keeps one folder per conversation:
//   ~/.gemini/antigravity-cli/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl
// with one line per finished step: USER_INPUT, PLANNER_RESPONSE (model, tokens, tool_calls) and
// GENERIC (a tool's result, in the order the calls were made). Lines are only appended. The same
// steps are also in transcript.jsonl and chunks/, which are skipped so nothing counts twice.
// Only names, step numbers, statuses and times are read; message text, thinking and tool
// arguments other than the short label never leave this module.
//
// A second subscription runs the same CLI with its own HOME: <home>/.agy-acct2, a folder of
// symlinks mirroring the real home but with its own .gemini/ and .config/antigravity/. Every
// .agy-acct<N> (N >= 2) with a real .gemini/antigravity-cli is another account, and only that
// agent folder is read: its other symlinks point back into the real home, and following them
// would count every Claude/Codex/omp session twice. Sessions are labelled acct1, acct2, ... and
// keyed by account plus conversation id.

const fs = require('fs');
const path = require('path');
const { at, projectOf, allowed, touch, classify, shortLabel } = require('./shared');

const provider = 'gemini';
const FILE_TAIL = `${path.sep}.system_generated${path.sep}logs${path.sep}transcript_full.jsonl`;
const SEEN_CAP = 2000;

// agy tool names that the shared rules would put on the wrong station.
const STATION = {
  search_web: 'web',
  read_url: 'web',
  read_url_content: 'web',
  list_dir: 'files',
  find_by_name: 'files',
  grep_search: 'files',
  code_search: 'files',
  codebase_search: 'files',
  view_code_item: 'files',
};

// agy names its path and command arguments differently from Claude; the shared label rules read
// `path` and `command`. Only the program name or the last two path segments end up in the label.
const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'FilePath', 'DirectoryPath', 'SearchPath', 'SearchDirectory'];

function root(home) {
  return path.join(home, '.gemini', 'antigravity-cli', 'brain');
}

const ACCOUNT_DIR = /^\.agy-acct([2-9]\d*)$/;
const ACCOUNT_PATH = /[\\/]\.agy-acct([2-9]\d*)[\\/]\.gemini[\\/]antigravity-cli[\\/]/;

function realDir(dir) {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Account 1 is the real home; every profile home under it whose .gemini/antigravity-cli is a real
// folder (not a symlink) is another account, in numeric order.
function accounts(home) {
  const list = [{ label: 'acct1', home, primary: true }];
  let items;
  try {
    items = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return list;
  }
  const extra = [];
  for (const item of items) {
    const match = ACCOUNT_DIR.exec(item.name);
    if (!match || !item.isDirectory()) continue;
    const dir = path.join(home, item.name);
    if (!realDir(path.join(dir, '.gemini')) || !realDir(path.join(dir, '.gemini', 'antigravity-cli'))) continue;
    extra.push({ n: Number(match[1]), label: `acct${Number(match[1])}`, home: dir, primary: false });
  }
  extra.sort((a, b) => a.n - b.n);
  return list.concat(extra.map(({ label, home: dir, primary }) => ({ label, home: dir, primary })));
}

function roots(home) {
  return accounts(home).map(account => root(account.home));
}

function accountOf(file) {
  const match = ACCOUNT_PATH.exec(String(file || ''));
  return match ? `acct${Number(match[1])}` : 'acct1';
}

function isTranscript(file) {
  return String(file || '').endsWith(FILE_TAIL);
}

function conversationOf(file) {
  const s = String(file || '');
  if (!isTranscript(s)) return '';
  return path.basename(s.slice(0, -FILE_TAIL.length));
}

// The board and the usage ledger key a conversation by account too: the same id in two accounts
// must stay two sessions.
function sessionKeyOf(file) {
  const conversation = conversationOf(file);
  return conversation ? `${accountOf(file)}:${conversation}` : '';
}

// cache/last_conversations.json maps a working folder to its newest conversation id. A new
// conversation becomes the newest when it starts, so the live reader sees it; ids learned once
// are kept.
const cwdById = new Map();
let cwdCache = { file: '', at: 0 };
function cwdOf(file) {
  const id = conversationOf(file);
  if (!id) return '';
  const brain = path.dirname(String(file).slice(0, -FILE_TAIL.length));
  const map = path.join(path.dirname(brain), 'cache', 'last_conversations.json');
  const now = Date.now();
  if (!cwdById.has(id) && (cwdCache.file !== map || now - cwdCache.at > 5e3)) {
    cwdCache = { file: map, at: now };
    try {
      const data = JSON.parse(fs.readFileSync(map, 'utf8'));
      for (const [dir, conv] of Object.entries(data || {})) {
        if (typeof conv === 'string' && conv && typeof dir === 'string') cwdById.set(conv, dir);
      }
    } catch {
      // No map yet.
    }
  }
  return cwdById.get(id) || '';
}

function remember(set, id) {
  set.add(id);
  if (set.size > SEEN_CAP) set.delete(set.values().next().value);
}

function labelArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  if (typeof args.CommandLine === 'string') out.command = args.CommandLine;
  for (const key of PATH_KEYS) {
    if (typeof args[key] === 'string' && args[key]) {
      out.path = args[key];
      break;
    }
  }
  return out;
}

function stationOf(name, args) {
  return STATION[String(name || '').toLowerCase()] || classify(name, args);
}

function handle(ctx, session, event) {
  if (!event || typeof event !== 'object') return;
  if (!isTranscript(session.file)) return;
  if (!session.agy) {
    const account = accountOf(session.file);
    session.key = sessionKeyOf(session.file) || session.file;
    session.agy = { steps: new Set(), pending: [], account };
  }
  if (!session.cwd) session.cwd = cwdOf(session.file);
  const seen = session.agy;
  const account = seen.account;
  const step = Number(event.step_index);
  if (!Number.isInteger(step) || typeof event.type !== 'string') return;
  if (seen.steps.has(step)) return;
  remember(seen.steps, step);

  const time = at(session, { timestamp: event.created_at }, ctx.now);
  const key = String(session.key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(-60) || 's';
  const failed = String(event.status || '').toUpperCase() !== 'DONE';
  const live = time.record && allowed(ctx, session);

  // Steps that finished but whose line came late still settle what was open.
  const finishTools = status => {
    for (const id of seen.pending.splice(0)) ctx.board.finish(id, status, ctx.now());
  };
  const finishTurn = status => {
    if (!session.openTurn) return;
    ctx.board.finish(session.openTurn, status, ctx.now());
    session.openTurn = undefined;
  };

  if (event.type === 'USER_INPUT') {
    finishTools('ok');
    finishTurn('ok');
    if (!live) return;
    const project = projectOf(session);
    const turnId = `agy-turn-${key}-${step}`;
    ctx.board.add({
      id: `agy-you-${key}-${step}`,
      provider,
      station: 'you',
      label: 'new message',
      status: 'ok',
      startedAt: time.at,
      endedAt: time.at,
      project,
      detail: { kind: 'Antigravity prompt', project, session: String(session.key), account },
    });
    ctx.board.add({
      id: turnId,
      provider,
      station: 'model',
      label: 'Antigravity working',
      status: 'run',
      startedAt: time.at,
      project,
      detail: { kind: 'Antigravity turn', project, session: String(session.key), account },
    });
    session.openTurn = turnId;
    touch(ctx, provider, session);
    return;
  }

  if (event.type === 'PLANNER_RESPONSE') {
    if (typeof event.model === 'string' && event.model) ctx.board.setModel(provider, event.model, time.at, session.key);
    finishTools('ok');
    const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
    if (failed) {
      finishTurn('err');
    } else if (!calls.length) {
      finishTurn('ok');
    } else if (live) {
      const project = projectOf(session);
      calls.forEach((call, i) => {
        if (!call || typeof call !== 'object') return;
        const name = String(call.name || 'tool');
        const args = labelArgs(call.args);
        const id = `agy-tool-${key}-${step}-${i}`;
        ctx.board.add({
          id,
          provider,
          station: stationOf(name, args),
          label: shortLabel(name, args),
          status: 'run',
          startedAt: Math.max(time.at, ctx.now() - 1000),
          project,
          detail: { kind: 'Antigravity tool', tool: name, project, session: String(session.key), account },
        });
        seen.pending.push(id);
      });
    }
    if (live) touch(ctx, provider, session);
    return;
  }

  if (event.type === 'GENERIC') {
    const id = seen.pending.shift();
    if (id) ctx.board.finish(id, failed ? 'err' : 'ok', ctx.now());
    if (live) touch(ctx, provider, session);
  }
}

module.exports = { provider, root, roots, accounts, accountOf, sessionKeyOf, handle, cwdOf, conversationOf, isTranscript };
