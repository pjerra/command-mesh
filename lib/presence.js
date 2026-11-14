'use strict';

const { execFile } = require('child_process');
const path = require('path');

function startPresence({ board, intervalMs = 10000 }) {
  let stopped = false;

  function publish(stdout) {
    if (stopped) return;
    // Program name per process; for `node <script>` (Gemini CLI, npm installs) the script's name.
    const names = String(stdout || '')
      .split('\n')
      .map(line => {
        const words = line.trim().split(/\s+/).filter(Boolean);
        if (!words.length) return '';
        const first = path.basename(words[0]).toLowerCase();
        if (first !== 'node' && first !== 'nodejs') return first;
        const script = words.slice(1).find(word => !word.startsWith('-'));
        return script ? path.basename(script).toLowerCase() : first;
      })
      .filter(Boolean);
    const has = pattern => names.some(name => pattern.test(name));
    try {
      board.setPresence({
        claude: has(/^claude$/),
        codex: has(/^codex/),
        omp: has(/^omp(\s|$)/),
        gemini: has(/^gemini$/) || has(/^agy$/),
      });
    } catch {
      // Presence must never break the dashboard.
    }
  }

  function check() {
    if (stopped) return;
    execFile('ps', ['-A', '-o', 'args='], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
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
