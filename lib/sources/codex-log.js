'use strict';

// Codex run through the Claude Code plugin uses ephemeral app-server threads, so nothing is
// written under ~/.codex/sessions and the rollout source stays dark. Codex does write a live
// debug log to SQLite (<home>/.codex/logs_<N>.sqlite, WAL mode): table logs(id INTEGER,
// ts INTEGER seconds, ts_nanos, level, target, feedback_log_body TEXT, module_path, file,
// line, thread_id TEXT, process_uuid, estimated_bytes).
//
// Only ids, timestamps, targets, and tool metadata are ever selected. Prompt text (the
// Submission body) is never read or stored: SQL extracts just the 36-char turn id from it,
// and the JS side validates that shape before use.

const fs = require('fs');
const path = require('path');
const { classifyCodexTool, codexToolLabel } = require('../classify');

const POLL_LIMIT = 5000;
const RECORD_MS = 120e3;
const FUTURE_MS = 5e3;
const FORGET_MS = 10 * 60e3;
const RETRY_MS = 30e3;
const TURN_ID_RE = /^[0-9a-f-]{36}$/;
// The real row starts with a span prefix (`session_loop{thread_id=...}: `) before the marker, so
// the marker is located with instr(), not assumed to be at the start. The turn id is the 36
// characters right after it.
const TURN_MARKER = 'Submission sub=Submission { id: "';
const TURN_ID_LEN = 36;
const MARKER_AT = `instr(feedback_log_body, '${TURN_MARKER}')`;
// Codex 0.169 dropped the Submission row. A turn now shows as a span tag that every row of the
// turn repeats: submission_dispatch{... submission.id="<id>" codex.op="turn_input"}. The reader
// opens a turn on the first such row and ignores the repeats.
const SPAN_OP = 'codex.op="turn_input"';
const SPAN_MARKER = 'submission.id="';
const SPAN_AT = `instr(feedback_log_body, '${SPAN_MARKER}')`;
// Rows written after a model call carry the context size; the turn id sits in the same body.
const USAGE_MARKER = 'total_usage_tokens=';
const USAGE_AT = `instr(feedback_log_body, '${USAGE_MARKER}')`;
const USAGE_TURN_AT = "instr(feedback_log_body, 'turn_id=')";
const USAGE_ROW = "target='codex_core::session::turn' AND feedback_log_body LIKE '%post sampling token usage%'";

const QUERY = 'SELECT id, ts, target, thread_id, ' +
  "CASE WHEN target='codex_core::tools::parallel' THEN feedback_log_body END AS tool_body, " +
  'CASE WHEN ' +
  "target='codex_core::session::handlers' " +
  `AND ${MARKER_AT} > 0 ` +
  "AND feedback_log_body LIKE '%op: TurnInput%' " +
  `THEN substr(feedback_log_body, ${MARKER_AT} + ${TURN_MARKER.length}, ${TURN_ID_LEN}) ` +
  `WHEN instr(feedback_log_body, '${SPAN_OP}') > 0 AND ${SPAN_AT} > 0 ` +
  `THEN substr(feedback_log_body, ${SPAN_AT} + ${SPAN_MARKER.length}, ${TURN_ID_LEN}) END AS turn_id, ` +
  'CASE WHEN ' +
  "target='codex_app_server::outgoing_message' " +
  "AND feedback_log_body LIKE 'app-server event: turn/completed%' THEN 1 END AS turn_done " +
  'FROM logs WHERE id > ? ORDER BY id LIMIT ' + POLL_LIMIT;

// Usage rows only, for the history collector: the same post-sampling columns it always selected,
// never the whole body.
const USAGE_QUERY = 'SELECT id, ts, thread_id, ' +
  `CASE WHEN ${USAGE_ROW} THEN substr(feedback_log_body, ${USAGE_AT}, 40) END AS usage_part, ` +
  `CASE WHEN ${USAGE_ROW} AND ${USAGE_TURN_AT} > 0 THEN substr(feedback_log_body, ${USAGE_TURN_AT}, 50) END AS usage_turn ` +
  `FROM logs WHERE id > ? AND id <= ? AND ts >= ? AND ${USAGE_ROW} ORDER BY id LIMIT ` + POLL_LIMIT;

// node:sqlite prints an ExperimentalWarning on require; swap emitWarning for a no-op
// during that one require only.
function loadSqlite() {
  try {
    const emitWarning = process.emitWarning;
    process.emitWarning = () => {};
    try {
      return require('node:sqlite').DatabaseSync;
    } finally {
      process.emitWarning = emitWarning;
    }
  } catch {
    return null;
  }
}

// `dir` is a Codex home folder (.codex or a second CODEX_HOME); the newest logs_<N>.sqlite in it
// is the live log.
function findLogFileIn(dir) {
  try {
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      const m = /^logs_(\d+)\.sqlite$/.exec(name);
      if (m && (best === null || Number(m[1]) > Number(best[1]))) best = [name, m[1]];
    }
    return best ? path.join(dir, best[0]) : null;
  } catch {
    return null;
  }
}

function findLogFile(home) {
  return findLogFileIn(path.join(home, '.codex'));
}

// One reader per Codex home. Account 2 rows are labelled and keyed by account so its threads stay
// apart from account 1's; entry ids stay plain so a rollout row and a live-log row of the same turn
// still merge (they are the same turn seen twice).
function startLogReader({ board, dir, dbPath, account = '', now = Date.now, only = '', pollMs = 1000, quietMs = 120000, timers = true } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const threads = new Map();
  const keyOf = id => (account ? `${account}:${id}` : String(id));
  let DatabaseSync = null;
  let file = null;
  let db = null;
  let lastId = 0;
  let pollTimer = null;
  let retryTimer = null;

  const api = {
    enabled: false,
    path: null,
    reason: null,
    poll: () => {},
    dispose: () => {
      clearInterval(pollTimer);
      clearInterval(retryTimer);
      closeDb();
      api.enabled = false;
      api.poll = () => {};
    },
  };

  function projectOf(thread) {
    return path.basename(thread.cwd || '') || 'codex';
  }

  // Same `at` idea as shared.js, but rows are live so nothing is skipped: out-of-window
  // timestamps fall back to now() instead of dropping the event.
  function eventTime(ts) {
    const ms = Number(ts) * 1000;
    const t = clock();
    if (!Number.isFinite(ms)) return t;
    if (t - ms > RECORD_MS || ms - t > FUTURE_MS) return t;
    return ms;
  }

  // The `only` filter applies once a thread's cwd is known; unknown-cwd threads record.
  function blocked(thread) {
    return Boolean(only && thread.cwd && !String(thread.cwd).startsWith(only));
  }

  function openTurn(thread, threadId, turnId, time) {
    // Span tags repeat on every row of a turn and can arrive late, after the next turn opened:
    // remember every turn id this thread has opened (bounded), not only the newest.
    if (!thread.seenTurns) thread.seenTurns = new Set();
    if (thread.seenTurns.has(turnId)) return;
    thread.seenTurns.add(turnId);
    while (thread.seenTurns.size > 50) thread.seenTurns.delete(thread.seenTurns.values().next().value);
    if (thread.openTurn) board.finish(thread.openTurn, 'ok', time);
    const project = projectOf(thread);
    const detail = { kind: 'Codex turn (live log)', project, session: keyOf(threadId), ...(account ? { account } : {}) };
    board.add({
      id: `codex-you-${turnId}`, provider: 'codex', station: 'you', label: 'new Codex message',
      status: 'ok', startedAt: time, endedAt: time, project, detail: { ...detail },
    });
    board.add({
      id: `codex-turn-${turnId}`, provider: 'codex', station: 'model', label: 'Codex working',
      status: 'run', startedAt: time, project, detail: { ...detail },
    });
    thread.openTurn = `codex-turn-${turnId}`;
  }


  function closeNewestTurn(time) {
    let best = null;
    for (const thread of threads.values()) {
      if (!thread.openTurn) continue;
      // Ties (ts is seconds) go to the thread seen most recently.
      if (!best || thread.lastAt >= best.lastAt) best = thread;
    }
    if (best) {
      board.finish(best.openTurn, 'ok', time);
      best.openTurn = null;
    }
  }

  function sweep() {
    const t = clock();
    for (const [threadId, thread] of threads) {
      if (thread.openTurn && t - thread.lastAt > quietMs) {
        board.finish(thread.openTurn, 'ok', t);
        thread.openTurn = null;
      }
      if (t - thread.lastAt > FORGET_MS) threads.delete(threadId);
    }
  }

  function handleRow(row) {
    if (!row || typeof row !== 'object') return;
    const time = eventTime(row.ts);
    const threadId = typeof row.thread_id === 'string' && row.thread_id ? row.thread_id : null;
    if (threadId) {
      let thread = threads.get(threadId);
      if (!thread) {
        thread = { cwd: '', model: '', openTurn: null, lastAt: time };
        threads.set(threadId, thread);
      }
      thread.lastAt = time;
      // Learn cwd/model from the tool row before applying `only`: a blocked thread
      // records nothing, but a first-seen cwd may change the verdict below.
      let tool = null;
      if (typeof row.tool_body === 'string' && row.tool_body) {
        const parsed = {
          model: /model=([^\s}]+)/.exec(row.tool_body),
          cwd: /cwd=([^\s}]+)/.exec(row.tool_body),
          name: /tool_name=(\S+)/.exec(row.tool_body),
          call: /call_id=(\S+)/.exec(row.tool_body),
          duration: /total_duration_ms=(\d+)/.exec(row.tool_body),
        };
        if (parsed.model) {
          thread.model = parsed.model[1];
        }
        if (parsed.cwd) {
          const first = !thread.cwd;
          thread.cwd = parsed.cwd[1];
          if (first && thread.openTurn) {
            const project = projectOf(thread);
            board.patch(thread.openTurn, { project, detail: { project } });
            board.patch(thread.openTurn.replace('codex-turn-', 'codex-you-'), { project, detail: { project } });
          }
        }
        if (parsed.name && parsed.call) {
          tool = {
            name: parsed.name[1],
            call: parsed.call[1],
            ms: parsed.duration ? Number(parsed.duration[1]) : 0,
          };
        }
      }
      if (!blocked(thread)) {
        board.touch('codex', keyOf(threadId));
        if (thread.model) board.setModel('codex', thread.model, time, keyOf(threadId));
        if (typeof row.turn_id === 'string' && TURN_ID_RE.test(row.turn_id)) {
          openTurn(thread, threadId, row.turn_id, time);
        }
        if (tool) {
          const id = `codex-tool-${tool.call}`;
          const station = classifyCodexTool(tool.name, '');
          const project = projectOf(thread);
          const added = board.add({
            id, provider: 'codex', station, label: codexToolLabel(tool.name, station),
            status: 'ok', startedAt: time - tool.ms, endedAt: time, project,
            detail: { kind: 'Codex tool (live log)', tool: tool.name, project, session: keyOf(threadId), ...(account ? { account } : {}) },
          });
          // The rollout source may already hold this tool as running: same id, no doubling.
          if (!added) board.finish(id, 'ok', time);
        }
      }
    }
    if (row.turn_done) closeNewestTurn(time);
  }

  function closeDb() {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors.
      }
      db = null;
    }
  }

  function openDb() {
    closeDb();
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const got = db.prepare('SELECT MAX(id) AS m FROM logs').get();
      lastId = got && typeof got.m === 'number' ? got.m : 0;
      return true;
    } catch {
      closeDb();
      return false;
    }
  }

  function poll() {
    try {
      if (db || openDb()) {
        let rows = null;
        try {
          rows = db.prepare(QUERY).all(lastId);
        } catch {
          closeDb();
        }
        if (rows) {
          for (const row of rows) {
            if (row && typeof row.id === 'number' && row.id > lastId) lastId = row.id;
            try {
              handleRow(row);
            } catch {
              // One bad row must not stop the poll.
            }
          }
        }
      }
    } catch {
      closeDb();
    }
    try {
      sweep();
    } catch {
      // Never throw out of poll.
    }
  }

  function tryInit() {
    if (!DatabaseSync) {
      DatabaseSync = loadSqlite();
      if (!DatabaseSync) {
        api.reason = 'node:sqlite unavailable';
        return false;
      }
    }
    const found = dbPath || findLogFileIn(dir);
    if (!found) {
      api.reason = 'no logs database found';
      return false;
    }
    file = found;
    if (!openDb()) {
      api.reason = 'cannot open logs database';
      return false;
    }
    api.enabled = true;
    api.path = file;
    api.reason = null;
    api.poll = poll;
    return true;
  }

  tryInit();
  if (timers) {
    pollTimer = setInterval(() => {
      try {
        api.poll();
      } catch {
        // Never throw out of a timer.
      }
    }, pollMs);
    pollTimer.unref?.();
    if (!api.enabled) {
      retryTimer = setInterval(() => {
        if (!api.enabled) tryInit();
      }, RETRY_MS);
      retryTimer.unref?.();
    }
  }

  return api;
}

// Account 1 is <home>/.codex; the second login's CODEX_HOME, <home>/.codex-acct2, is account 2.
// Each home gets its own reader, cursor and thread map, so one failing database leaves the other
// account's rows untouched and a database that appears later is picked up by its own retry.
function startCodexLog({ board, home, dbPath, dbPath2, accounts, now = Date.now, only = '', pollMs = 1000, quietMs = 120000, timers = true } = {}) {
  const baseHome = home || require('os').homedir();
  const list = Array.isArray(accounts) && accounts.length
    ? accounts
    : [
      { account: '', dir: path.join(baseHome, '.codex'), dbPath },
      { account: 'acct2', dir: path.join(baseHome, '.codex-acct2'), dbPath: dbPath2 },
    ];
  const readers = list.map(entry => startLogReader({
    board, dir: entry.dir, dbPath: entry.dbPath, account: entry.account, now, only, pollMs, quietMs, timers,
  }));
  return {
    readers,
    get enabled() {
      return readers.some(reader => reader.enabled);
    },
    get path() {
      const on = readers.find(reader => reader.enabled);
      return on ? on.path : null;
    },
    get reason() {
      return readers.every(reader => !reader.enabled) ? readers[0].reason : null;
    },
    poll() {
      for (const reader of readers) {
        try {
          reader.poll();
        } catch {
          // One home's failure must not stop the other.
        }
      }
    },
    dispose() {
      for (const reader of readers) {
        try {
          reader.dispose();
        } catch {
          // Ignore dispose errors.
        }
      }
    },
  };
}

module.exports = { startCodexLog, startLogReader, findLogFile, findLogFileIn, loadSqlite, USAGE_QUERY };
