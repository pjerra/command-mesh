'use strict';

// Pace and forecast per limit window, from the window's own numbers: how much of the window's
// time has passed against how much of the limit is used. Pace is (time passed % - used %): plus
// means under pace, minus means using it faster than the window refills. The forecast keeps the
// average rate of the whole window so far, so it moves slowly instead of following a burst.

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Too early in a window the average rate says nothing; show the pace but no forecast yet.
const MIN_ELAPSED_FRACTION = 0.05;

function oneMonthBefore(ms) {
  const d = new Date(ms);
  d.setMonth(d.getMonth() - 1);
  return d.getTime();
}

// Window length in ms. Codex reports it; Claude and omp only name the window.
function windowMsOf(window) {
  if (!window || typeof window !== 'object') return 0;
  const given = Number(window.windowMs);
  if (Number.isFinite(given) && given > 0) return given;
  const label = String(window.label || '').trim();
  const short = /^(\d+)\s*([mhd])$/i.exec(label);
  if (short) {
    const n = Number(short[1]);
    const unit = short[2].toLowerCase();
    return n * (unit === 'm' ? MIN : unit === 'h' ? HOUR : DAY);
  }
  if (/week/i.test(label)) return 7 * DAY;
  if (/month/i.test(label)) {
    const resetsAt = Number(window.resetsAt);
    return Number.isFinite(resetsAt) ? resetsAt - oneMonthBefore(resetsAt) : 0;
  }
  return 0;
}

// { pace, projectedPct?, etaMs? } or null when the window has no length or reset time.
// etaMs is set only when the window runs out before it resets; projectedPct otherwise.
function paceOf(window, t) {
  const length = windowMsOf(window);
  const resetsAt = Number(window && window.resetsAt);
  if (!(length > 0) || !Number.isFinite(resetsAt)) return null;
  const left = resetsAt - t;
  if (!(left > 0) || left > length) return null;
  const elapsed = length - left;
  const used = Math.max(0, Number(window.usedPercent) || 0);
  const out = { pace: Math.round((elapsed / length) * 100 - used) };
  if (window.exhausted || used >= 100) return out;
  if (elapsed / length < MIN_ELAPSED_FRACTION) return out;
  const projected = (used * length) / elapsed;
  if (projected >= 100) out.etaMs = Math.round((elapsed * (100 - used)) / used);
  else out.projectedPct = Math.round(projected);
  return out;
}

function createForecast({ now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;

  // Kept for the board's call; the forecast needs no history.
  function observe() {}

  function decorate(limits, t = clock()) {
    if (!limits || typeof limits !== 'object') return limits;
    for (const source of ['claude', 'codex', 'omp', 'gemini']) {
      const entry = limits[source];
      if (!entry || !Array.isArray(entry.accounts)) continue;
      for (const account of entry.accounts) {
        if (!account || !Array.isArray(account.windows)) continue;
        for (const window of account.windows) {
          if (!window || typeof window !== 'object') continue;
          const result = paceOf(window, t);
          if (result) Object.assign(window, result);
        }
      }
    }
    return limits;
  }

  return { observe, decorate };
}

module.exports = { createForecast, paceOf, windowMsOf };
