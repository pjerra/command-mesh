'use strict';

const { execFile } = require('child_process');
const path = require('path');

function startPresence({ board, intervalMs = 10000 }) {
  let stopped = false;

  function publish(stdout) {
    if (stopped) return;
    const names = String(stdout || '')
      .split('\n')
      .map(line => path.basename(line.trim()).toLowerCase())
      .filter(Boolean);
    const has = pattern => names.some(name => pattern.test(name));
    try {
      board.setPresence({
        claude: has(/^claude$/),
        codex: has(/^codex/),
        omp: has(/^omp(\s|$)/),
      });
    } catch {
      // Presence must never break the dashboard.
    }
  }

  function check() {
    if (stopped) return;
    execFile('ps', ['-A', '-o', 'comm='], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return;
      publish(stdout);
    });
  }

  check();
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return {
    dispose() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { startPresence };
