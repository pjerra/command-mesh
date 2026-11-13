'use strict';

// Built-in fake activity for the DEMO mode. Nothing here reads the machine or the
// network: three agents loop through hand-written turns on a private clock. The
// random source is a seeded mulberry32 so a run is reproducible.

function mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { createLedger, localWeekStart, localMonthStart } = require('./usage/ledger');

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const AGENTS = [
  {
    provider: 'claude',
    name: 'Claude',
    project: 'demo-api',
    model: 'opus-5-5',
    sessions: ['demo-claude-a', 'demo-claude-b'],
    tools: [
      { station: 'files', tool: 'Read', label: 'Read src/routes/users.ts' },
      { station: 'files', tool: 'Edit', label: 'Edit src/routes/users.ts' },
      { station: 'files', tool: 'Grep', label: 'Grep src/routes' },
      { station: 'shell', tool: 'Bash', label: 'Bash npm' },
      { station: 'shell', tool: 'Bash', label: 'Bash git' },
      { station: 'web', tool: 'WebFetch', label: 'WebFetch api.example.com' },
      { station: 'web', tool: 'WebSearch', label: 'WebSearch node streams' },
      { station: 'browser', tool: 'playwright:click', label: 'playwright:click' },
      { station: 'agents', tool: 'Agent', label: 'Agent reviewer' },
      { station: 'skills', tool: 'Skill', label: 'Skill tdd' },
      { station: 'memory', tool: 'memory:recall', label: 'memory:recall' },
      { station: 'model', tool: 'todo', label: 'todo' },
      { station: 'hooks', tool: 'PreToolUse', label: 'PreToolUse' },
    ],
  },
  {
    provider: 'codex',
    name: 'Codex',
    project: 'demo-api',
    model: 'gpt-5.6-sol',
    sessions: ['demo-codex-a'],
    tools: [
      { station: 'shell', tool: 'exec', label: 'exec npm' },
      { station: 'shell', tool: 'exec', label: 'exec git' },
      { station: 'shell', tool: 'bash', label: 'bash go' },
      { station: 'files', tool: 'Read', label: 'Read src/review/diff.ts' },
      { station: 'web', tool: 'WebSearch', label: 'WebSearch sqlite wal' },
      { station: 'browser', tool: 'playwright:click', label: 'playwright:click' },
      { station: 'agents', tool: 'wait', label: 'wait' },
      { station: 'skills', tool: 'Skill', label: 'Skill tdd' },
      { station: 'memory', tool: 'memory:recall', label: 'memory:recall' },
      { station: 'model', tool: 'todo', label: 'todo' },
      { station: 'hooks', tool: 'PreToolUse', label: 'PreToolUse' },
    ],
  },
  {
    provider: 'omp',
    name: 'OMP',
    project: 'demo-web',
    model: 'muse-spark-1.3-contributor',
    sessions: ['demo-omp-a', 'demo-omp-b', 'demo-omp-c'],
    tools: [
      { station: 'files', tool: 'Read', label: 'Read src/app/page.tsx' },
      { station: 'files', tool: 'Edit', label: 'Edit src/app/page.tsx' },
      { station: 'files', tool: 'Grep', label: 'Grep src/app' },
      { station: 'shell', tool: 'Bash', label: 'Bash npm' },
      { station: 'shell', tool: 'Bash', label: 'Bash git' },
      { station: 'web', tool: 'WebSearch', label: 'WebSearch css grid' },
      { station: 'browser', tool: 'playwright:click', label: 'playwright:click' },
      { station: 'agents', tool: 'wait', label: 'wait' },
      { station: 'skills', tool: 'Skill', label: 'Skill tdd' },
      { station: 'memory', tool: 'memory:recall', label: 'memory:recall' },
      { station: 'model', tool: 'todo', label: 'todo' },
      { station: 'hooks', tool: 'PreToolUse', label: 'PreToolUse' },
    ],
  },
];

// base + rate * seconds, wrapped at 100 so the bars fill and start over.
const LIMIT_PLAN = {
  claude: [{
    name: 'CLAUDE',
    windows: [
      { label: '5h', base: 74, rate: 0.5, reset: 3 * HOUR },
      { label: 'Week', base: 31, rate: 0.1, reset: 5 * DAY },
      { label: 'Fable', windowMs: 7 * DAY, base: 58, rate: 0.3, reset: 5 * DAY + HOUR },
    ],
  }],
  codex: [{
    name: 'CODEX',
    plan: 'plus',
    windows: [
      { label: '5h', base: 88, rate: 0.2, reset: 2 * HOUR },
      { label: 'Week', base: 14, rate: 0.05, reset: 6 * DAY },
    ],
  }],
  omp: [
    {
      name: 'OMP go1',
      windows: [
        { label: '5h', base: 62, rate: 0.4, reset: 4 * HOUR },
        { label: 'Week', base: 45, rate: 0.1, reset: 3 * DAY },
        { label: 'Month', fixed: 100, exhausted: true, reset: 12 * DAY },
      ],
    },
    {
      name: 'OMP go2',
      windows: [
        { label: '5h', base: 4, rate: 0.05, reset: 5 * HOUR },
        { label: 'Week', base: 3, rate: 0.03, reset: 4 * DAY },
      ],
    },
    {
      name: 'OMP go3',
      windows: [
        { label: '5h', base: 96, rate: 0.35, reset: 4 * HOUR },
        { label: 'Week', base: 71, rate: 0.2, reset: 5 * DAY },
      ],
    },
  ],
};

function startDemo({ board, ledger: suppliedLedger, now = Date.now, timers = true, speed = 1, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const startedAt = now();
  const ledger = suppliedLedger || createLedger({ now });
  let clock = startedAt;
  let seq = 0;
  let disposed = false;
  let timer = null;
  const jobs = [];
  const agents = AGENTS.map(agent => ({ ...agent, turn: 0 }));

  // Made-up but plausible per-anchor totals, so every period tab has all three agents.
  const USAGE_SHAPES = {
    claude: { input: 1_100_000, cacheRead: 88_400_000, cacheWrite5m: 5_200_000, cacheWrite1h: 0, output: 1_500_000, cost: 103.2, rough: false },
    codex: { input: 1_200_000, cacheRead: 6_600_000, cacheWrite5m: 0, cacheWrite1h: 0, output: 300_000, cost: 2.35, rough: true },
    omp: { input: 4_900_000, cacheRead: 25_300_000, cacheWrite5m: 0, cacheWrite1h: 0, output: 800_000, cost: 1.53, rough: false },
  };
  const weekStart = localWeekStart(startedAt);
  const monthStart = localMonthStart(startedAt);
  const anchors = [
    startedAt - 5 * 60e3,
    startedAt - 60e3,
    Math.floor((weekStart + startedAt) / 2),
    Math.floor((monthStart + startedAt) / 2),
  ];
  for (const agent of agents) {
    const shape = USAGE_SHAPES[agent.provider];
    anchors.forEach((at, index) => {
      ledger.add({ provider: agent.provider, at, model: agent.model, ...shape, key: `demo-history-${agent.provider}-${index}` });
    });
  }

  function demoUsage(agent, at, index, step) {
    const shape = USAGE_SHAPES[agent.provider];
    const factor = 0.12 + rand() * 0.4;
    return {
      provider: agent.provider,
      at,
      model: agent.model,
      input: Math.round(shape.input * factor),
      cacheRead: Math.round(shape.cacheRead * factor),
      cacheWrite5m: Math.round(shape.cacheWrite5m * factor),
      cacheWrite1h: 0,
      output: Math.round(shape.output * factor),
      cost: shape.cost * factor,
      rough: shape.rough,
      key: `demo-live-${agent.provider}-${index}-${step}`,
    };
  }

  function at(when, fn) {
    jobs.push({ at: Math.max(clock, when), seq: seq++, fn });
  }

  function later(delay, fn) {
    at(clock + Math.max(0, delay), fn);
  }

  function step(ms) {
    if (disposed) return;
    const amount = Number(ms);
    const target = clock + (Number.isFinite(amount) && amount > 0 ? amount : 0);
    for (;;) {
      let best = -1;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (job.at > target) continue;
        if (best < 0 || job.at < jobs[best].at || (job.at === jobs[best].at && job.seq < jobs[best].seq)) best = i;
      }
      if (best < 0) break;
      const job = jobs.splice(best, 1)[0];
      if (job.at > clock) clock = job.at;
      try {
        job.fn();
      } catch {
        // A demo event must never break the board or the page.
      }
    }
    clock = target;
  }

  function limitsNow() {
    const t = (clock - startedAt) / 1000;
    const wrap = spec => Math.max(0, Math.round((spec.base + spec.rate * t) % 100));
    const windows = plan => plan.map(spec => {
      const win = { label: spec.label, usedPercent: spec.fixed !== undefined ? spec.fixed : wrap(spec) };
      if (spec.windowMs) win.windowMs = spec.windowMs;
      if (spec.exhausted) win.exhausted = true;
      win.resetsAt = startedAt + spec.reset;
      return win;
    });
    for (const source of ['claude', 'codex', 'omp']) {
      const accounts = LIMIT_PLAN[source].map(plan => {
        const account = { name: plan.name, windows: windows(plan.windows) };
        if (plan.plan) account.plan = plan.plan;
        return account;
      });
      board.setLimits(source, { status: 'ok', checkedAt: clock, accounts });
    }
  }

  function limitsTick() {
    limitsNow();
    later(1000, limitsTick);
  }

  function startTurn(agent) {
    const index = agent.turn++;
    const session = agent.sessions[Math.floor(rand() * agent.sessions.length) % agent.sessions.length];
    for (const key of agent.sessions) board.touch(agent.provider, key);
    const started = clock;
    const project = agent.project;
    const turnId = `demo-turn-${agent.provider}-${index}`;
    board.add({
      id: `demo-you-${agent.provider}-${index}`,
      provider: agent.provider,
      station: 'you',
      label: 'new message',
      status: 'ok',
      startedAt: started,
      endedAt: started,
      project,
      detail: { kind: 'Demo prompt', project, session },
    });
    board.add({
      id: turnId,
      provider: agent.provider,
      station: 'model',
      label: `${agent.name} working`,
      status: 'run',
      startedAt: started,
      project,
      detail: { kind: 'Demo turn', project, session },
    });
    const toolCount = 3 + Math.floor(rand() * 7);
    let when = started;
    for (let i = 0; i < toolCount; i++) {
      const tool = agent.tools[Math.floor(rand() * agent.tools.length) % agent.tools.length];
      const duration = Math.round(400 + rand() * 3600);
      const toolStart = when;
      const toolEnd = toolStart + duration;
      const failed = rand() < (tool.station === 'hooks' ? 1 / 6 : 1 / 12);
      const usage = demoUsage(agent, toolEnd, index, i);
      const id = `demo-tool-${agent.provider}-${index}-${i}`;
      at(toolStart, () => {
        board.add({
          id,
          provider: agent.provider,
          station: tool.station,
          label: tool.label,
          status: 'run',
          startedAt: toolStart,
          project,
          detail: { kind: 'Demo tool', tool: tool.tool, project, session },
        });
      });
      at(toolEnd, () => {
        board.finish(id, failed ? 'err' : 'ok', toolEnd);
        ledger.add(usage);
      });
      when = toolEnd;
    }
    at(when, () => board.finish(turnId, 'ok', when));
    later(when - clock + 2000 + rand() * 6000, () => startTurn(agent));
  }

  for (const agent of agents) {
    board.setModel(agent.provider, agent.model);
    for (const key of agent.sessions) board.touch(agent.provider, key);
  }
  board.setPresence({ claude: true, codex: true, omp: true });
  limitsNow();
  later(0, limitsTick);
  for (const agent of agents) later(0, () => startTurn(agent));

  if (timers) {
    let last = now();
    timer = setInterval(() => {
      const t = now();
      const elapsed = Math.max(0, t - last);
      last = t;
      step(elapsed * (Number.isFinite(speed) && speed > 0 ? speed : 1));
    }, 250);
    timer.unref?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    jobs.length = 0;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { step, dispose, ledger };
}

module.exports = { startDemo };
