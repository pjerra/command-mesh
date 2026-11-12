'use strict';

// Per-minute activity counts for the chart on the dashboard. The board feeds every new entry
// here, bars() folds the minutes into the four ranges the page offers, and the file next to the
// usage cache keeps the last 24 hours across restarts.

const fs = require('fs');
const path = require('path');

const PROVIDERS = ['claude', 'codex', 'omp'];
const MINUTE = 60e3;
const DAY = 24 * 3600e3;
const SAVE_MS = 60e3;

const RANGES = {
  '30m': { count: 30, step: MINUTE },
  '2h': { count: 24, step: 5 * MINUTE },
  '8h': { count: 32, step: 15 * MINUTE },
  '24h': { count: 48, step: 30 * MINUTE },
};

function minuteStart(ms) {
  return Math.floor(ms / MINUTE) * MINUTE;
}

function emptyMinute() {
  return { claude: 0, codex: 0, omp: 0, stations: {} };
}

function providerOf(entry) {
  const explicit = entry.provider;
  if (PROVIDERS.includes(explicit)) return explicit;
  const id = String(entry.id || '');
  for (const provider of PROVIDERS) {
    if (id.startsWith(provider + '-')) return provider;
  }
  return 'claude';
}

function createActivity({ now = Date.now, file = null } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const minutes = new Map();
  let lastSave = 0;

  function prune() {
    const cutoff = clock() - DAY;
    for (const key of minutes.keys()) {
      if (key < cutoff) minutes.delete(key);
    }
  }

  function add(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const startedAt = Number(entry.startedAt);
    if (!Number.isFinite(startedAt)) return false;
    const key = minuteStart(startedAt);
    prune();
    if (key < clock() - DAY) return false;
    let bucket = minutes.get(key);
    if (!bucket) {
      bucket = emptyMinute();
      minutes.set(key, bucket);
    }
    bucket[providerOf(entry)] += 1;
    if (entry.station) {
      const station = String(entry.station);
      bucket.stations[station] = (bucket.stations[station] || 0) + 1;
    }
    return true;
  }

  function bars(range = '30m', at = clock()) {
    const spec = RANGES[range] || RANGES['30m'];
    const end = Number.isFinite(Number(at)) ? Number(at) : clock();
    prune();
    const out = [];
    for (let i = spec.count - 1; i >= 0; i--) {
      const from = end - (i + 1) * spec.step;
      const to = end - i * spec.step;
      const per = { claude: 0, codex: 0, omp: 0 };
      const stations = {};
      for (const [key, bucket] of minutes) {
        if (key < from || key >= to) continue;
        for (const provider of PROVIDERS) per[provider] += bucket[provider] || 0;
        for (const [station, count] of Object.entries(bucket.stations || {})) {
          stations[station] = (stations[station] || 0) + count;
        }
      }
      out.push({ from, to, per, stations });
    }
    return out;
  }

  function toJSON() {
    prune();
    const out = { version: 1, minutes: {} };
    for (const [key, bucket] of minutes) {
      out.minutes[String(key)] = {
        claude: bucket.claude || 0,
        codex: bucket.codex || 0,
        omp: bucket.omp || 0,
        stations: { ...bucket.stations },
      };
    }
    return out;
  }

  function fromJSON(data) {
    minutes.clear();
    if (!data || typeof data !== 'object' || !data.minutes || typeof data.minutes !== 'object') return false;
    for (const [key, value] of Object.entries(data.minutes)) {
      const at = Number(key);
      if (!Number.isFinite(at) || !value || typeof value !== 'object') continue;
      const bucket = emptyMinute();
      for (const provider of PROVIDERS) {
        bucket[provider] = Math.max(0, Math.floor(Number(value[provider]) || 0));
      }
      if (value.stations && typeof value.stations === 'object') {
        for (const [station, count] of Object.entries(value.stations)) {
          const n = Math.floor(Number(count) || 0);
          if (n > 0) bucket.stations[String(station).slice(0, 40)] = n;
        }
      }
      minutes.set(minuteStart(at), bucket);
    }
    prune();
    return true;
  }

  function save(force) {
    if (!file) return false;
    const t = clock();
    if (!force && t - lastSave < SAVE_MS) return false;
    prune();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(toJSON()));
      fs.renameSync(temp, file);
      lastSave = t;
      return true;
    } catch {
      // The chart history is an optimisation; a read-only home must not stop the dashboard.
      return false;
    }
  }

  function close() {
    return save(true);
  }

  if (file) {
    try {
      fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // A missing or corrupt file starts empty.
    }
  }

  return {
    add,
    bars,
    toJSON,
    fromJSON,
    save,
    close,
    file,
    get size() {
      return minutes.size;
    },
  };
}

// The activity file lives in the same folder as the usage cache: next to --cache-file when that
// flag is set, otherwise under the home cache directory.
function activityFile({ home, cacheFile } = {}) {
  const dir = cacheFile ? path.dirname(cacheFile) : path.join(home || '', '.cache', 'command-mesh');
  return path.join(dir, 'activity-v1.json');
}

module.exports = { createActivity, activityFile, RANGES };
