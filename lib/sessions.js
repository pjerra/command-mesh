'use strict';

// Per-session view of the board. The board keeps events; this keeps one row per session: when it
// started, its newest label, the model (from board.setModel), whether a run entry is still open,
// how many errors landed in the last ten minutes, and the cost the usage collector attributed to
// the session's file. The cost map is separate because the ledger does not know sessions.

const path = require('path');
const { localDayStart } = require('./usage/ledger');

const PROVIDERS = ['claude', 'codex', 'omp'];

function createSessions({
  now = Date.now,
  activeMs = 30 * 60e3,
  forgetMs = 2 * 3600e3,
  idleFlagMs = 10 * 60e3,
  errorWindowMs = 10 * 60e3,
  errorFlagCount = 3,
  spotlightWindowMs = 60 * 60e3,
  spotlightCap = 500,
  maxRows = 21,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const states = new Map();
  const costs = new Map();
  const errs = [];

  function composite(provider, key) {
    return `${provider}|${key}`;
  }

  function sessionFor(provider, key) {
    const id = composite(provider, key);
    let state = states.get(id);
    if (!state) {
      state = {
        provider,
        key,
        firstAt: null,
        lastAt: 0,
        lastLabel: '',
        model: '',
        project: '',
        sub: false,
        open: new Set(),
        errors: [],
      };
      states.set(id, state);
    }
    return state;
  }

  function recordError(state, at, project, label, entryId) {
    state.errors.push({ at, id: entryId });
    while (state.errors.length > spotlightCap) state.errors.shift();
    errs.push({ at, project, label: String(label || '').slice(0, 100), id: entryId });
    while (errs.length > spotlightCap) errs.shift();
  }

  function note(entry, model) {
    if (!entry || !PROVIDERS.includes(entry.provider)) return;
    const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail : {};
    const key = typeof detail.session === 'string' ? detail.session.trim() : '';
    if (!key) return;
    const at = Number(entry.startedAt);
    if (!Number.isFinite(at)) return;
    const state = sessionFor(entry.provider, key);
    if (state.firstAt === null || at < state.firstAt) state.firstAt = at;
    if (typeof model === 'string' && model) state.model = model;
    const project = String(entry.project || detail.project || '');
    if (project) state.project = project;
    if (at >= state.lastAt) {
      state.lastAt = at;
      state.lastLabel = String(entry.label || '');
    }
    if (detail.subagent === true || /subagent/i.test(String(detail.kind || ''))) state.sub = true;
    if (entry.status === 'run') state.open.add(entry.id);
    else if (entry.status === 'err') recordError(state, at, project || state.project, entry.label, entry.id);
  }

  function end(entry) {
    if (!entry || !PROVIDERS.includes(entry.provider)) return;
    const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail : {};
    const key = typeof detail.session === 'string' ? detail.session.trim() : '';
    if (!key) return;
    const state = states.get(composite(entry.provider, key));
    if (!state) return;
    const at = Number(entry.endedAt);
    const time = Number.isFinite(at) ? at : Number.isFinite(Number(entry.startedAt)) ? Number(entry.startedAt) : clock();
    state.open.delete(entry.id);
    if (time >= state.lastAt) {
      state.lastAt = time;
      if (entry.label) state.lastLabel = String(entry.label);
    }
    const project = String(entry.project || detail.project || state.project);
    if (entry.status === 'err') recordError(state, time, project, entry.label, entry.id);
  }

  function setModel(provider, model) {
    if (!PROVIDERS.includes(provider) || typeof model !== 'string' || !model) return;
    for (const state of states.values()) {
      if (state.provider === provider) state.model = model;
    }
  }

  // The collector knows the file but not the board's session key. Claude names the file after the
  // session id; a subagent file sits under the parent session folder. Codex rollout names carry the
  // session id at the end. omp usually names the file after the id. Anything else stays unmapped,
  // and the row shows --.
  function keyForFile(provider, file) {
    const base = path.basename(String(file || '')).replace(/\.jsonl$/i, '');
    if (!base) return '';
    if (provider === 'claude') {
      const marker = '/subagents/';
      const index = String(file).indexOf(marker);
      if (index >= 0) {
        const parent = String(file).slice(0, index).replace(/\/+$/, '').split('/').pop();
        if (parent) return parent;
      }
      return base;
    }
    for (const state of states.values()) {
      if (state.provider !== provider) continue;
      if (state.key === base) return base;
      if (base.endsWith(state.key) || base.startsWith(state.key)) return state.key;
    }
    return base;
  }

  function cost(record) {
    if (!record || !PROVIDERS.includes(record.provider)) return;
    const amount = Number(record.cost);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const at = Number(record.at);
    if (!Number.isFinite(at)) return;
    const day = localDayStart(clock());
    if (at < day) return;
    const key = keyForFile(record.provider, record.file);
    if (!key) return;
    const id = composite(record.provider, key);
    let entry = costs.get(id);
    if (!entry || entry.day !== day) {
      entry = { day, total: 0 };
      costs.set(id, entry);
    }
    entry.total += amount;
  }

  function costFor(state, day) {
    const entry = costs.get(composite(state.provider, state.key));
    if (!entry || entry.day !== day) return null;
    return Math.round(entry.total * 10000) / 10000;
  }

  function pruneStates(t) {
    for (const [id, state] of states) {
      if (t - state.lastAt > forgetMs) {
        states.delete(id);
        costs.delete(id);
      }
    }
  }

  function pruneErrors(list, t, windowMs) {
    return list.filter(item => t - item.at <= windowMs);
  }

  function rows() {
    const t = clock();
    pruneStates(t);
    const day = localDayStart(t);
    const out = [];
    for (const state of states.values()) {
      if (t - state.lastAt > activeMs) continue;
      const recent = pruneErrors(state.errors, t, errorWindowMs);
      state.errors = recent;
      const idleMs = Math.max(0, t - state.lastAt);
      const running = state.open.size > 0;
      const idleFlag = running && idleMs > idleFlagMs;
      const errorFlag = recent.length >= errorFlagCount;
      const project = state.project || 'unknown';
      out.push({
        key: state.key,
        provider: state.provider,
        project,
        name: project + (state.sub ? ' · subagent' : ''),
        model: state.model || '',
        label: state.lastLabel,
        firstAt: state.firstAt === null ? state.lastAt : state.firstAt,
        lastAt: state.lastAt,
        sub: state.sub,
        running,
        idleMs,
        idleFlag,
        errorFlag,
        errorsRecent: recent.length,
        costToday: costFor(state, day),
        flagged: idleFlag || errorFlag,
      });
    }
    out.sort((a, b) => (b.flagged ? 1 : 0) - (a.flagged ? 1 : 0) || b.lastAt - a.lastAt);
    return out.slice(0, maxRows);
  }

  // The spotlight outlives the board's 30 minute window: a separate rolling list of errors for
  // the last hour, grouped by project and label (never arguments).
  function errors() {
    const t = clock();
    const groups = new Map();
    for (const item of errs) {
      if (t - item.at > spotlightWindowMs) continue;
      const id = `${item.project}\u0000${item.label}`;
      let group = groups.get(id);
      if (!group) {
        group = { count: 0, label: item.label, project: item.project, lastAt: item.at };
        groups.set(id, group);
      }
      group.count += 1;
      if (item.at > group.lastAt) group.lastAt = item.at;
    }
    return [...groups.values()]
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, 5)
      .map(({ count, label, project }) => ({ count, label, project }));
  }

  function forget() {
    pruneStates(clock());
  }

  function has(provider, key) {
    return states.has(composite(provider, key));
  }

  return { note, end, setModel, cost, rows, errors, forget, has, get size() { return states.size; } };
}

module.exports = { createSessions };
