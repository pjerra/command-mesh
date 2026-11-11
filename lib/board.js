'use strict';

const STALE_TOUCH_MS = 120e3;

function cleanModel(model) {
  let s = String(model ?? '').replace(/[\r\n]+/g, ' ').trim();
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  if (s.toLowerCase().startsWith('claude-')) s = s.slice('claude-'.length);
  return s.trim().slice(0, 40);
}

function createBoard({ now = Date.now, keep = 1500, maxAgeMs = 30 * 60e3, staleRunMs = 10 * 60e3 } = {}) {
  const entries = [];
  const counts = {};
  const models = {};
  const usage = {};
  const touches = { claude: new Map(), codex: new Map(), omp: new Map() };
  let presence = {};
  const startedAt = now();

  function add(entry) {
    if (entries.some(e => e.id === entry.id)) return false;
    entries.push(entry);
    counts[entry.station] = (counts[entry.station] || 0) + 1;
    while (entries.length > keep) entries.shift();
    const cutoff = now() - maxAgeMs;
    while (entries.length && entries[0].startedAt < cutoff) entries.shift();
    return true;
  }

  function finish(id, status, endedAt, patch) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.id === id && e.status === 'run') {
        e.status = status;
        e.endedAt = endedAt;
        if (patch && typeof patch.label === 'string') e.label = patch.label;
        return true;
      }
    }
    return false;
  }

  function setModel(provider, model) {
    const cleaned = cleanModel(model);
    if (cleaned) models[provider] = cleaned;
  }

  function touch(provider, sessionKey) {
    const map = touches[provider];
    if (map) map.set(sessionKey, now());
  }

  function addCost(provider, amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    const prev = usage[provider];
    usage[provider] = { last: n, session: (prev ? prev.session : 0) + n, lastAt: now() };
  }

  function setPresence(obj) {
    presence = { ...obj, at: now() };
  }

  function snapshot() {
    const t = now();
    const list = entries.map(e => {
      const copy = { ...e, detail: { ...e.detail } };
      if (copy.status === 'run' && t - copy.startedAt > staleRunMs) {
        copy.status = 'ok';
        copy.endedAt = copy.startedAt;
      }
      return copy;
    });
    const sessions = {};
    for (const p of ['claude', 'codex', 'omp']) {
      let n = 0;
      for (const at of touches[p].values()) {
        if (t - at <= STALE_TOUCH_MS) n++;
      }
      sessions[p] = n;
    }
    return {
      entries: list,
      counts: { ...counts },
      models: { ...models },
      presence: { ...presence },
      usage: JSON.parse(JSON.stringify(usage)),
      sessions,
      startedAt,
    };
  }

  return { add, finish, setModel, touch, addCost, setPresence, snapshot };
}

module.exports = { createBoard };
