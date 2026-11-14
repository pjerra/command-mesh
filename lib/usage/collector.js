'use strict';

// Usage history collector. Back-fills the ledger from the session logs on disk (the same roots the
// activity tails use), then keeps reading the files that grow and the Codex live log. The work is
// split into files and small chunks so a background pass never blocks the HTTP server.

const fs = require('fs');
const path = require('path');
const { walkJsonl } = require('../tail');
const omp = require('../sources/omp');
const { findLogFile, loadSqlite, USAGE_QUERY } = require('../sources/codex-log');
const { localWeekStart, localMonthStart } = require('./ledger');
const { claudeUsage, ompUsage, codexRolloutUsage, codexLogUsage, geminiUsage } = require('./parse');

const CHUNK = 4 * 1024 * 1024;
const LIVE_MS = 5000;
const WALK_MS = 30000;
const SAVE_MS = 60000;
const TURN_CAP = 10000;
const SEEN_CAP = 500;

function windowStart(ms) {
  // The brief asks for the earliest of this month and this week.
  return Math.min(localWeekStart(ms), localMonthStart(ms));
}

function createCodexReader({ home, dbPath }) {
  let db = null;
  let file = null;
  return {
    read(lastId, sinceTs) {
      if (!db) {
        const DatabaseSync = loadSqlite();
        if (!DatabaseSync) return { rows: [], maxId: 0 };
        file = dbPath || findLogFile(home);
        if (!file) return { rows: [], maxId: 0 };
        try {
          db = new DatabaseSync(file, { readOnly: true });
        } catch {
          db = null;
          return { rows: [], maxId: 0 };
        }
      }
      try {
        const top = db.prepare('SELECT MAX(id) AS m FROM logs').get();
        const maxId = top && Number.isFinite(Number(top.m)) ? Number(top.m) : 0;
        if (maxId <= lastId) return { rows: [], maxId };
        return { rows: db.prepare(USAGE_QUERY).all(lastId, maxId, sinceTs) || [], maxId };
      } catch {
        try {
          db.close();
        } catch {
          // Ignore close errors.
        }
        db = null;
        return { rows: [], maxId: 0 };
      }
    },
    get path() {
      return file;
    },
    close() {
      if (!db) return;
      try {
        db.close();
      } catch {
        // Ignore close errors.
      }
      db = null;
    },
  };
}

function startCollector({
  ledger,
  home,
  now = Date.now,
  timers = true,
  cacheFile,
  onProgress,
  onRecord,
  codexRows,
  codexDbPath,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const cachePath = cacheFile || path.join(home, '.cache', 'command-mesh', 'usage-v1.json');
  const win = windowStart(clock());
  const startedAt = clock();

  const roots = [path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions'), path.join(home, '.gemini', 'tmp')];
  try {
    roots.push(...omp.roots(home));
  } catch {
    roots.push(path.join(home, '.omp', 'agent', 'sessions'));
  }

  const files = new Map();
  const threads = new Map();
  let pricedTurns = new Set();
  let lastId = 0;
  let loading = true;
  let progress = 0;
  let disposed = false;
  let lastSave = 0;
  let lastWalk = 0;
  let liveTimer = null;

  const codexReader = codexRows ? null : createCodexReader({ home, dbPath: codexDbPath });
  const readRows = codexRows || ((last, since) => codexReader.read(last, since));

  function loadCache() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    try {
      ledger.fromJSON(data.ledger);
    } catch {
      // A corrupt ledger section starts empty.
    }
    if (data.files && typeof data.files === 'object') {
      for (const [file, state] of Object.entries(data.files)) {
        if (!state || typeof state !== 'object') continue;
        const seen = new Set(Array.isArray(state.seen) ? state.seen.slice(-SEEN_CAP).map(String) : []);
        files.set(file, {
          file,
          offset: Number(state.offset) || 0,
          mtimeMs: Number(state.mtimeMs) || 0,
          size: Number(state.size) || 0,
          seen,
          pending: Buffer.alloc(0),
        });
      }
    }
    if (data.codex && typeof data.codex.lastId === 'number') lastId = data.codex.lastId;
    if (Array.isArray(data.pricedTurns)) pricedTurns = new Set(data.pricedTurns.slice(-TURN_CAP).map(String));
  }

  function discover() {
    const found = [];
    for (const root of roots) {
      try {
        walkJsonl(root, 8, found);
      } catch {
        // A missing root is normal.
      }
    }
    for (const file of found) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < win) {
        files.delete(file);
        continue;
      }
      const known = files.get(file);
      if (known) {
        known.mtimeMs = stat.mtimeMs;
        continue;
      }
      files.set(file, {
        file,
        offset: 0,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        seen: new Set(),
        pending: Buffer.alloc(0),
      });
    }
    return found.length;
  }

  function rememberTurn(id) {
    if (!id) return;
    pricedTurns.add(String(id));
    while (pricedTurns.size > TURN_CAP) pricedTurns.delete(pricedTurns.values().next().value);
  }

  function parseLine(line, state) {
    if (!line.includes('"usage"') && !line.includes('"token_count"') && !line.includes('"tokens"')) return null;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'message' && event.message && event.message.role === 'assistant') {
      return ompUsage(event, state);
    }
    if (event.type === 'assistant') return claudeUsage(event, state);
    if (event.type === 'gemini') return geminiUsage(event, state);
    if (event.type === 'event_msg' && event.payload && event.payload.type === 'token_count') {
      return codexRolloutUsage(event, state);
    }
    return null;
  }

  function readFile(file, state) {
    const session = state || files.get(file);
    if (!session) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    session.mtimeMs = stat.mtimeMs;
    session.size = stat.size;
    if (stat.size < session.offset) {
      session.offset = 0;
      session.pending = Buffer.alloc(0);
      session.seen = new Set();
    }
    if (stat.size === session.offset && !session.pending.length) return;

    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      let position = session.offset;
      while (position < stat.size) {
        const length = Math.min(CHUNK, stat.size - position);
        const chunk = Buffer.allocUnsafe(length);
        let read = 0;
        try {
          read = fs.readSync(fd, chunk, 0, length, position);
        } catch {
          break;
        }
        if (!read) break;
        position += read;
        const part = read === length ? chunk : chunk.subarray(0, read);
        const buffered = session.pending.length ? Buffer.concat([session.pending, part]) : part;
        const lastNewline = buffered.lastIndexOf(10);
        if (lastNewline < 0) {
          session.pending = Buffer.from(buffered);
          continue;
        }
        const complete = buffered.subarray(0, lastNewline + 1);
        session.offset += complete.length;
        session.pending = Buffer.from(buffered.subarray(lastNewline + 1));
        for (const line of complete.toString('utf8').split('\n')) {
          if (!line) continue;
          const record = parseLine(line, session);
          if (!record) continue;
          if (!(record.at >= win)) continue;
          ledger.add(record);
          if (record.turnId) rememberTurn(record.turnId);
          if (onRecord) {
            try {
              record.file = session.file;
              onRecord(record);
            } catch {
              // A record listener must never break the collector.
            }
          }
        }
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }

  function pollCodex() {
    let result;
    try {
      result = readRows(lastId, Math.floor(win / 1000));
    } catch {
      result = null;
    }
    const rows = Array.isArray(result) ? result : (result && result.rows) || [];
    const scanTo = Array.isArray(result) ? 0 : Number(result && result.maxId) || 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.id === 'number') {
        if (row.id <= lastId) continue;
        lastId = row.id;
      }
      const threadId = typeof row.thread_id === 'string' ? row.thread_id : '';
      let thread = threads.get(threadId);
      if (!thread) {
        thread = { lastTotal: undefined, model: '' };
        threads.set(threadId, thread);
      }
      const record = codexLogUsage(row, thread);
      if (!record) continue;
      // A turn already priced from its rollout is never priced again from the live log.
      if (record.turnId && pricedTurns.has(record.turnId)) continue;
      ledger.add(record);
    }
    if (scanTo > lastId) lastId = scanTo;
  }

  function report(done, total) {
    progress = total > 0 ? done / total : loading ? 0 : 1;
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ done, total, progress });
    } catch {
      // A progress callback must never break the collector.
    }
  }

  function save(force) {
    const t = clock();
    if (!force && t - lastSave < SAVE_MS) return;
    const table = {};
    for (const [file, state] of files) {
      if (state.mtimeMs && state.mtimeMs < win) {
        files.delete(file);
        continue;
      }
      table[file] = {
        size: state.size || 0,
        offset: state.offset,
        mtimeMs: state.mtimeMs,
        seen: [...state.seen].slice(-SEEN_CAP),
      };
    }
    const data = {
      version: 1,
      ledger: ledger.toJSON(),
      files: table,
      codex: { lastId },
      pricedTurns: [...pricedTurns].slice(-TURN_CAP),
    };
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const temp = `${cachePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(data));
      fs.renameSync(temp, cachePath);
      lastSave = t;
    } catch {
      // The cache is an optimisation; a read-only home must not stop the dashboard.
    }
  }

  async function backfill() {
    discover();
    const list = [...files.keys()];
    report(0, list.length);
    let done = 0;
    for (const file of list) {
      if (disposed) return;
      readFile(file, files.get(file));
      done++;
      report(done, list.length);
      await new Promise(resolve => setImmediate(resolve));
    }
    pollCodex();
    loading = false;
    progress = 1;
    report(done, list.length);
    save(true);
  }

  function poll() {
    if (disposed) return;
    for (const [file, state] of files) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        files.delete(file);
        continue;
      }
      if (stat.size !== state.size || stat.mtimeMs !== state.mtimeMs) readFile(file, state);
    }
    const t = clock();
    if (t - lastWalk >= WALK_MS) {
      lastWalk = t;
      discover();
    }
    pollCodex();
    save(false);
  }

  loadCache();
  const ready = backfill().catch(() => {
    loading = false;
    progress = 1;
  });
  if (timers) {
    liveTimer = setInterval(() => {
      try {
        poll();
      } catch {
        // Never throw out of a timer.
      }
    }, LIVE_MS);
    liveTimer.unref?.();
  }

  return {
    cacheFile: cachePath,
    ready,
    poll,
    state() {
      return { loading, progress };
    },
    get files() {
      return files.size;
    },
    get loading() {
      return loading;
    },
    get elapsedMs() {
      return clock() - startedAt;
    },
    close() {
      if (disposed) return;
      disposed = true;
      clearInterval(liveTimer);
      liveTimer = null;
      try {
        poll();
      } catch {
        // Best effort final read.
      }
      save(true);
      if (codexReader) codexReader.close();
    },
  };
}

module.exports = { startCollector, windowStart };
