'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const MAX_READ_BYTES = 8 * 1024 * 1024;
const HEAD_CWD_BYTES = 8192;
const RECENT_MS = 15 * 60e3;

function headCwd(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const stat = fs.fstatSync(handle);
    const n = Math.min(stat.size, HEAD_CWD_BYTES);
    if (!n) return '';
    const buffer = Buffer.alloc(n);
    fs.readSync(handle, buffer, 0, n, 0);
    const match = buffer.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (!match) return '';
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return '';
    }
  } catch {
    return '';
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function walkJsonl(root, maxDepth, out) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (root.endsWith('.jsonl')) out.push(root);
    return;
  }
  if (!stat.isDirectory()) return;
  const pending = [{ dir: root, depth: 0 }];
  while (pending.length) {
    const { dir, depth } = pending.pop();
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (depth < maxDepth) pending.push({ dir: full, depth: depth + 1 });
      } else if (item.isFile() && item.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
}

function startTail({ root, maxDepth = 5, onEvent, now = Date.now, discoverMs = 5000, pollMs = 700, timers = true }) {
  const clock = typeof now === 'function' ? now : Date.now;
  const files = new Map();
  let firstPass = true;

  function statOf(file) {
    try {
      return fs.statSync(file);
    } catch {
      return null;
    }
  }

  function discover() {
    try {
      if (!root) {
        firstPass = false;
        return;
      }
      const found = [];
      walkJsonl(root, maxDepth, found);
      for (const file of found) {
        const stat = statOf(file);
        if (!stat) continue;
        const known = files.get(file);
        if (known) {
          known.mtimeMs = stat.mtimeMs;
          continue;
        }
        files.set(file, {
          file,
          offset: firstPass ? stat.size : 0,
          carry: '',
          cwd: headCwd(file),
          key: file,
          mtimeMs: stat.mtimeMs,
          fresh: !firstPass,
          decoder: new StringDecoder('utf8'),
        });
      }
      firstPass = false;
    } catch {
      firstPass = false;
    }
  }

  function resetSession(session) {
    session.carry = '';
    session.decoder = new StringDecoder('utf8');
  }

  function readRange(file, start, end) {
    const length = end - start;
    if (length <= 0) return Buffer.alloc(0);
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        let n = 0;
        try {
          n = fs.readSync(handle, buffer, read, length - read, start + read);
        } catch {
          break;
        }
        if (!n) break;
        read += n;
      }
      return buffer.slice(0, read);
    } finally {
      try {
        fs.closeSync(handle);
      } catch {
        // Ignore close errors.
      }
    }
  }

  function poll() {
    try {
      for (const session of files.values()) {
        try {
          if (!session.fresh && clock() - (session.mtimeMs || 0) > RECENT_MS) continue;
          const stat = statOf(session.file);
          if (!stat) continue;
          session.mtimeMs = stat.mtimeMs;
          if (stat.size < session.offset) {
            session.offset = 0;
            resetSession(session);
          }
          if (stat.size === session.offset) continue;
          let start = session.offset;
          if (stat.size - session.offset > MAX_READ_BYTES) {
            start = stat.size - MAX_READ_BYTES;
            resetSession(session);
          }
          let bytes;
          try {
            bytes = readRange(session.file, start, stat.size);
          } catch {
            continue;
          }
          session.offset = stat.size;
          if (!bytes.length) continue;
          const text = session.carry + session.decoder.write(bytes);
          const parts = text.split('\n');
          session.carry = parts.pop() ?? '';
          for (const line of parts) {
            if (!line.trim()) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            try {
              onEvent(session, event);
            } catch {
              // One bad consumer must not stop the tail.
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Never throw out of poll.
    }
  }

  discover();
  let discoverTimer = null;
  let pollTimer = null;
  if (timers) {
    discoverTimer = setInterval(discover, discoverMs);
    pollTimer = setInterval(poll, pollMs);
    discoverTimer.unref?.();
    pollTimer.unref?.();
  }

  return {
    discover,
    poll,
    dispose() {
      clearInterval(discoverTimer);
      clearInterval(pollTimer);
    },
  };
}

module.exports = { startTail, headCwd, walkJsonl };
