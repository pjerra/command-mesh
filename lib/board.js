'use strict';

const STALE_TOUCH_MS = 120e3;
const COSTED_CAP = 10000;

function cleanModel(model) {
  let s = String(model ?? '').replace(/[\r\n]+/g, ' ').trim();
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  if (s.toLowerCase().startsWith('claude-')) s = s.slice('claude-'.length);
  return s.trim().slice(0, 40);
}

function createBoard({ now = Date.now, keep = 1500, maxAgeMs = 30 * 60e3, staleRunMs = 10 * 60e3, activity = null, sessions = null, forecast = null } = {}) {
  const entries = [];
  const counts = {};
  const models = {};
  const usage = {};
  const touches = { claude: new Map(), codex: new Map(), omp: new Map(), gemini: new Map() };
  const costed = { claude: new Set(), codex: new Set(), omp: new Set(), gemini: new Set() };
  let presence = {};
  const limits = {};
  const startedAt = now();

  function add(entry) {
    if (entries.some(e => e.id === entry.id)) return false;
    entries.push(entry);
    if (activity) activity.add(entry);
    if (sessions) sessions.note(entry, models[entry.provider]);
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
        if (sessions) sessions.end(e);
        return true;
      }
    }
    return false;
  }

  function patch(id, fields) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.id === id) {
        if (fields && typeof fields === 'object') {
          if (typeof fields.project === 'string') e.project = fields.project;
          if (fields.detail && typeof fields.detail === 'object') {
            e.detail = { ...e.detail, ...fields.detail };
          }
        }
        return true;
      }
    }
    return false;
  }

  // Every model an agent used recently, not just the latest one: the header lists them all. `at` is the
  // event's own time (old log lines read at start must not count as in use now); `key` is the session
  // the model belongs to, so one session's model never overwrites another's.
  const modelsSeen = { claude: new Map(), codex: new Map(), omp: new Map(), gemini: new Map() };
  const MODEL_ACTIVE_MS = 30 * 60e3;
  function setModel(provider, model, at, key) {
    const cleaned = cleanModel(model);
    if (!cleaned) return;
    models[provider] = cleaned;
    const when = Number.isFinite(Number(at)) ? Number(at) : now();
    const seen = modelsSeen[provider];
    if (seen && now() - when < MODEL_ACTIVE_MS && when >= (seen.get(cleaned) || 0)) seen.set(cleaned, when);
    if (sessions && key) sessions.setModel(provider, cleaned, key);
  }
  function modelsInUse() {
    const t = now();
    const out = {};
    for (const [provider, seen] of Object.entries(modelsSeen)) {
      for (const [model, at] of seen) if (t - at >= MODEL_ACTIVE_MS) seen.delete(model);
      out[provider] = [...seen].sort((a, b) => b[1] - a[1]).map(([model, at]) => ({ model, at }));
    }
    return out;
  }

  function touch(provider, sessionKey) {
    const map = touches[provider];
    if (map) map.set(sessionKey, now());
  }

  function addCost(provider, amount, opts) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    const prev = usage[provider];
    const entry = { last: n, session: (prev ? prev.session : 0) + n, lastAt: now() };
    // A rough estimate contaminates the sum: keep the mark even after an exact value is added.
    if (opts && opts.rough) entry.rough = true;
    else if (prev && prev.rough) entry.rough = true;
    usage[provider] = entry;
  }

  // Costed ids are turn ids (live log) so the two Codex readers price each turn once.
  function markCosted(provider, id) {
    const set = costed[provider];
    if (!set || id === undefined || id === null || id === '') return false;
    set.add(String(id));
    while (set.size > COSTED_CAP) set.delete(set.values().next().value);
    return true;
  }

  function isCosted(provider, id) {
    const set = costed[provider];
    return Boolean(set && id !== undefined && id !== null && set.has(String(id)));
  }

  function setPresence(obj) {
    presence = { ...obj, at: now() };
  }

  function setLimits(source, result) {
    if (source !== 'claude' && source !== 'codex' && source !== 'omp' && source !== 'gemini') return;
    if (!result || typeof result !== 'object') return;
    try {
      limits[source] = JSON.parse(JSON.stringify(result));
      if (forecast) forecast.observe(source, result);
    } catch {
      // A limit result must never break the board.
    }
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
    for (const p of ['claude', 'codex', 'omp', 'gemini']) {
      let n = 0;
      for (const at of touches[p].values()) {
        if (t - at <= STALE_TOUCH_MS) n++;
      }
      sessions[p] = n;
    }
    let limitCopy;
    try {
      limitCopy = JSON.parse(JSON.stringify(limits));
      if (forecast) forecast.decorate(limitCopy, t);
    } catch {
      limitCopy = { claude: undefined, codex: undefined, omp: undefined, gemini: undefined };
    }
    return {
      entries: list,
      counts: { ...counts },
      models: { ...models },
      modelsInUse: modelsInUse(),
      presence: { ...presence },
      usage: JSON.parse(JSON.stringify(usage)),
      sessions,
      limits: limitCopy,
      startedAt,
    };
  }

  return { add, finish, patch, setModel, modelsInUse, touch, addCost, markCosted, isCosted, setPresence, setLimits, snapshot };
}

module.exports = { createBoard };
