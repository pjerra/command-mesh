'use strict';

// Usage growth per limit window. Each limits refresh records (time, usedPercent); a window is
// predicted to be full when the least-squares slope over the last 30 minutes is positive and the
// prediction lands before the window resets. Samples live in memory only.

const KEEP_MS = 30 * 60e3;
const MIN_SPAN_MS = 5 * 60e3;
const MIN_SAMPLES = 2;
const SAMPLE_CAP = 240;

function slopePerMinute(samples) {
  const first = samples[0].t;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const sample of samples) {
    const x = (sample.t - first) / 60e3;
    sx += x;
    sy += sample.pct;
    sxx += x * x;
    sxy += x * sample.pct;
  }
  const n = samples.length;
  const denom = n * sxx - sx * sx;
  if (!denom) return 0;
  return (n * sxy - sx * sy) / denom;
}

function createForecast({ now = Date.now, keepMs = KEEP_MS, minSpanMs = MIN_SPAN_MS } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const series = new Map();

  function keyOf(source, account, window) {
    return `${source}|${account}|${window}`;
  }

  function observe(source, result) {
    if (!result || !Array.isArray(result.accounts)) return;
    const t = clock();
    for (const account of result.accounts) {
      if (!account || !Array.isArray(account.windows)) continue;
      for (const window of account.windows) {
        if (!window || !(Number(window.usedPercent) > 0)) continue;
        const resetsAt = Number(window.resetsAt);
        if (!Number.isFinite(resetsAt)) continue;
        const key = keyOf(source, account.name || '', window.label || '');
        let entry = series.get(key);
        if (!entry || entry.resetsAt !== resetsAt) {
          entry = { resetsAt, samples: [] };
          series.set(key, entry);
        }
        const pct = Number(window.usedPercent);
        const last = entry.samples[entry.samples.length - 1];
        if (last && last.t === t && last.pct === pct) continue;
        entry.samples.push({ t, pct });
        entry.samples = entry.samples.filter(sample => t - sample.t <= keepMs);
        if (entry.samples.length > SAMPLE_CAP) entry.samples.splice(0, entry.samples.length - SAMPLE_CAP);
      }
    }
  }

  function etaFor(source, account, window, t = clock()) {
    const key = keyOf(source, account.name || '', window.label || '');
    const entry = series.get(key);
    if (!entry) return null;
    if (entry.resetsAt !== Number(window.resetsAt)) return null;
    const samples = entry.samples.filter(sample => t - sample.t <= keepMs);
    if (samples.length < MIN_SAMPLES) return null;
    if (samples[samples.length - 1].t - samples[0].t < minSpanMs) return null;
    const slope = slopePerMinute(samples);
    if (!(slope > 0)) return null;
    const used = Number(window.usedPercent);
    if (!(used < 100)) return null;
    const etaMs = ((100 - used) / slope) * 60e3;
    const resetIn = entry.resetsAt - t;
    if (!(resetIn > 0) || etaMs >= resetIn) return null;
    return Math.round(etaMs);
  }

  function decorate(limits, t = clock()) {
    if (!limits || typeof limits !== 'object') return limits;
    for (const source of ['claude', 'codex', 'omp']) {
      const entry = limits[source];
      if (!entry || !Array.isArray(entry.accounts)) continue;
      for (const account of entry.accounts) {
        if (!account || !Array.isArray(account.windows)) continue;
        for (const window of account.windows) {
          if (!window || typeof window !== 'object') continue;
          const etaMs = etaFor(source, account, window, t);
          if (etaMs !== null) window.etaMs = etaMs;
        }
      }
    }
    return limits;
  }

  return { observe, decorate, etaFor };
}

module.exports = { createForecast, slopePerMinute };
