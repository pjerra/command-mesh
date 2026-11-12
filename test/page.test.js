const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { page } = require('../lib/page');
const { start } = require('../mesh');

function stubElement() {
  const el = {
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    title: '',
    children: [],
    appendChild(child) { el.children.push(child); return child; },
    before() {},
    after() {},
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    closest() { return null; },
    querySelector() { return stubElement(); },
    querySelectorAll() { return []; },
  };
  el.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  return el;
}

async function renderDashboard(state, opts = {}) {
  const html = page('body{}');
  const script = html.split('<script>')[1].split('</script>')[0];
  const stubs = new Map();
  const forSelector = sel => {
    if (!stubs.has(sel)) stubs.set(sel, stubElement());
    return stubs.get(sel);
  };
  const urls = [];
  const storage = opts.storage || new Map();
  const notes = [];
  function StubNotification(title, options) {
    notes.push({ title, body: options && options.body });
  }
  StubNotification.permission = opts.permission || 'granted';
  StubNotification.requestPermission = async () => StubNotification.permission;
  const context = {
    document: {
      querySelector: sel => forSelector(sel),
      querySelectorAll: () => [],
      createElement: () => stubElement(),
    },
    fetch: async url => {
      urls.push(String(url));
      return { json: async () => ({ state, svg: '<svg/>' }) };
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: key => { storage.delete(key); },
    },
    Notification: StubNotification,
    console,
  };
  if (opts.now !== undefined) {
    const RealDate = Date;
    const fixed = opts.now;
    context.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixed);
        else super(...args);
      }
      static now() { return fixed; }
    };
  }
  vm.createContext(context);
  let error = null;
  try {
    vm.runInContext(script, context, { filename: 'page-script.js' });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  } catch (err) {
    error = err;
  }
  assert.strictEqual(error, null, `page script threw: ${error && error.stack}`);
  const dashboard = forSelector('#dashboard');
  return { dashboard: dashboard.innerHTML, element: dashboard, context, urls, notes, storage };
}

test('page: the script renders the telemetry panel without throwing', async () => {
  const { dashboard } = await renderDashboard({
    entries: [
      { id: 'claude-turn-1', provider: 'claude', station: 'model', label: 'Claude working', status: 'run', startedAt: Date.now(), project: 'demo' },
      { id: 'claude-you-0', provider: 'claude', station: 'you', label: 'new message', status: 'ok', startedAt: Date.now(), endedAt: Date.now(), project: 'demo' },
    ],
    counts: { model: 1, you: 1 },
    models: { claude: 'opus' },
    presence: {},
    usage: { omp: { last: 0.004, session: 0.12, lastAt: Date.now() } },
    sessions: { claude: 1, codex: 0, omp: 1 },
  });
  assert.ok(dashboard.includes('Sessions'), 'telemetry panel shows Sessions KPI');
  assert.ok(dashboard.includes('class="proj"'), 'feed row carries project span');
});

test('page: Est. cost sums all three and the tooltip lists each', async () => {
  const { dashboard } = await renderDashboard({
    entries: [],
    counts: {},
    models: {},
    presence: {},
    usage: {
      claude: { last: 0.01, session: 1.236, lastAt: Date.now() },
      codex: { last: 0.02, session: 0.404, lastAt: Date.now(), rough: true },
      omp: { last: 0.003, session: 0.12, lastAt: Date.now() },
    },
    sessions: { claude: 1, codex: 1, omp: 1 },
  });
  assert.ok(dashboard.includes('<span>Est. cost</span><b>$1.76</b>'), 'the KPI sums the three costs');
  assert.ok(
    dashboard.includes('title="Claude $1.24 · Codex ~$0.404 · OMP $0.120"'),
    'the tooltip names each provider and its cost',
  );
  assert.ok(!dashboard.includes('OMP cost'), 'the old OMP-only KPI is gone');

  const { dashboard: empty } = await renderDashboard({ entries: [], usage: {}, sessions: {} });
  assert.ok(empty.includes('<span>Est. cost</span><b>--</b>'), 'nothing yet shows --');
});

test('page: tabs switch the table, the Tokens and Est. cost KPIs and the request period', async () => {
  const per = (cost, tokens, rough = false) => ({
    cost, tokens, input: tokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, rough,
  });
  const periods = {
    hour: {
      label: 'last 60 min', from: 0,
      per: { claude: per(1, 1000), codex: per(0, 0), omp: per(0, 0), total: per(1, 1000) },
      bars: [{ from: 0, to: 1, per: { claude: per(1, 1000), codex: per(0, 0), omp: per(0, 0) } }],
    },
    today: {
      label: 'Thu 12 Nov', from: 0,
      per: { claude: per(2, 2e6), codex: per(3, 3e6, true), omp: per(0, 0), total: per(5, 5e6) },
      bars: [],
    },
    week: {
      label: 'Mon 9 Nov → now', from: 0,
      per: { claude: per(3, 3e6), codex: per(2, 2e6, true), omp: per(2, 2e6), total: per(7, 7e6) },
      bars: [],
    },
    month: {
      label: 'November', from: 0,
      per: { claude: per(4, 4e6), codex: per(4, 4e6, true), omp: per(3, 3e6), total: per(11, 11e6) },
      bars: [],
    },
  };
  const state = {
    entries: [],
    sessions: {},
    usage: { loading: false, progress: 1, period: 'today', periods, lastAdd: {} },
  };
  const { dashboard: initial, element, context, urls } = await renderDashboard(state);
  assert.ok(urls[0].includes('period=today'), 'the default request asks for today');
  assert.ok(initial.includes('<span>Est. cost</span><b>$5.00</b>'), 'today KPI sums the three agents');
  assert.ok(initial.includes('<span>Tokens</span><b>~5M</b>'), 'Tokens KPI shows the period total, marked rough');
  assert.ok(initial.includes('data-period="today"'), 'today tab exists');
  assert.ok(initial.includes('COST PER HOUR · TODAY'), 'the chart names the today bucket');

  context.setPeriod('month');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const monthly = element.innerHTML;
  assert.ok(monthly.includes('<span>Est. cost</span><b>$11.00</b>'), 'month KPI follows the tab');
  assert.ok(monthly.includes('<span>Tokens</span><b>~11M</b>'), 'Tokens KPI follows the tab');
  assert.ok(monthly.includes('data-period="month"') && monthly.includes('usage-tab active" data-period="month"'), 'month tab is active');
  assert.ok(monthly.includes('COST PER DAY · MONTH'), 'the chart switches unit and period');
  assert.ok(monthly.includes('~$4.00'), 'rough estimates are marked in the table');
  assert.ok(urls.some(url => url.includes('period=month')), 'the next request carries the chosen period');
  assert.ok(!monthly.includes('$5.00'), 'the old period numbers are gone from the KPIs');
});

test('page: range tabs switch the request and the header; click filters only in 30m', async () => {
  const now = Date.now();
  const bars = Array.from({ length: 30 }, (_, i) => ({
    from: now - (30 - i) * 60e3,
    to: now - (29 - i) * 60e3,
    per: { claude: i === 0 || i === 29 ? 1 : 0, codex: 0, omp: 0 },
    stations: { files: 1 },
  }));
  const state = {
    entries: [
      {
        id: 'claude-you-old', provider: 'claude', station: 'you', label: 'older event', status: 'ok',
        startedAt: now - 29.5 * 60e3, endedAt: now - 29.5 * 60e3, project: 'demo',
      },
      {
        id: 'claude-you-new', provider: 'claude', station: 'you', label: 'fresh event', status: 'ok',
        startedAt: now - 10e3, endedAt: now - 10e3, project: 'demo',
      },
    ],
    counts: {},
    models: {},
    presence: {},
    sessions: {},
    usage: {},
    activity: { range: '30m', bars },
  };
  const { dashboard, element, context, urls } = await renderDashboard(state);
  assert.ok(urls[0].includes('range=30m'), 'the default request asks for 30m');
  assert.ok(dashboard.includes('ACTIVITY \u00b7 LAST 30 MINUTES'), 'the header names the default range');
  assert.ok(dashboard.includes('data-range="30m"') && dashboard.includes('data-range="24h"'), 'the four tabs exist');
  assert.ok(dashboard.includes('data-bar="0"'), '30m bars carry the click index');
  assert.ok(dashboard.includes('data-id="claude-you-old"') && dashboard.includes('data-id="claude-you-new"'), 'the feed starts with both events');

  context.selectActivityBar(0);
  const filtered = element.innerHTML;
  assert.ok(filtered.includes('data-id="claude-you-old"'), 'the clicked minute keeps its event');
  assert.ok(!filtered.includes('data-id="claude-you-new"'), 'the feed is limited to the clicked minute');
  assert.ok(filtered.includes('CLICK AGAIN TO CLEAR'), 'the chart shows the active minute');

  context.setActivityRange('2h');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const long = element.innerHTML;
  assert.ok(urls.some(url => url.includes('range=2h')), 'the next request carries the chosen range');
  assert.ok(long.includes('ACTIVITY \u00b7 LAST 2 HOURS'), 'the header follows the range');
  assert.ok(!long.includes('data-bar='), 'longer ranges are not clickable');
  assert.ok(long.includes('data-id="claude-you-old"') && long.includes('data-id="claude-you-new"'), 'the click filter is cleared');

  context.selectActivityBar(0);
  const unchanged = element.innerHTML;
  assert.ok(unchanged.includes('data-id="claude-you-old"') && unchanged.includes('data-id="claude-you-new"'), 'a click in a long range does nothing');
});

test('page: alerts fire once per threshold per window per reset, not in demo', async () => {
  const now = 1_700_000_000_000;
  const limits = (pct, resetsAt, exhausted = false) => ({
    omp: {
      status: 'ok',
      checkedAt: now,
      accounts: [{ name: 'OMP go2', windows: [{ label: 'Week', usedPercent: pct, resetsAt, exhausted }] }],
    },
  });
  const state = { entries: [], sessions: [], errors: [], limits: limits(80, now + 4 * 86400e3) };
  const { context, notes, storage } = await renderDashboard(state, { now });

  context.setAlerts(true);
  assert.strictEqual(context.checkAlerts(state), 1, '80 percent fires one notification');
  assert.strictEqual(notes.length, 1);
  assert.ok(/OMP go2 Week 80 %/.test(notes[0].body), `body was ${notes[0].body}`);
  assert.ok(/resets in/.test(notes[0].body));
  assert.strictEqual(context.checkAlerts(state), 0, 'the same threshold does not fire again');
  assert.strictEqual(notes.length, 1);

  const high = { ...state, limits: limits(95, now + 4 * 86400e3) };
  assert.strictEqual(context.checkAlerts(high), 1, '95 percent fires again');
  assert.strictEqual(notes.length, 2);
  assert.ok(/OMP go2 Week 95 %/.test(notes[1].body));
  assert.strictEqual(context.checkAlerts(high), 0);

  const out = { ...state, limits: limits(100, now + 4 * 86400e3, true) };
  assert.strictEqual(context.checkAlerts(out), 1, 'exhaustion fires once');
  assert.ok(/exhausted/.test(notes[2].body));
  assert.strictEqual(context.checkAlerts(out), 0);

  const reset = { ...state, limits: limits(96, now + 5 * 86400e3) };
  assert.strictEqual(context.checkAlerts(reset), 1, 'a new reset period has its own thresholds');
  assert.ok(storage.get('command-mesh-alerted').includes(String(now + 5 * 86400e3)), 'fired keys remember the reset time');

  context.setMode(true);
  const demoState = { ...state, limits: limits(99, now + 6 * 86400e3) };
  assert.strictEqual(context.checkAlerts(demoState), 0, 'demo mode never notifies');
});

test('burn: last-hour cost and the today projection', async () => {
  const noon = new Date(2026, 10, 13, 12, 0, 0, 0).getTime();
  const state = {
    entries: [],
    sessions: [],
    errors: [],
    usage: {
      periods: {
        hour: { per: { claude: { cost: 2 }, codex: { cost: 1 }, omp: { cost: 1 }, total: { cost: 4 } } },
        today: { per: { claude: { cost: 5 }, codex: { cost: 3 }, omp: { cost: 2 }, total: { cost: 10 } } },
      },
    },
  };
  const { dashboard } = await renderDashboard(state, { now: noon });
  assert.ok(dashboard.includes('<span>Burn</span><b>$4/h</b>'), 'the last hour is shown per hour');
  assert.ok(dashboard.includes('title="Claude $2/h · Codex $1/h · OMP $1/h"'), 'the tooltip splits the burn per agent');
  assert.ok(dashboard.includes('~$58 today'), 'twelve hours left at $4/h on top of $10 is $58');
});

test('server: /state carries sessions and errors; page renders both and the row click filters the feed', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sessions-'));
  const handle = start({ port: 0, home, timers: false, noLimits: true, noHistory: true });
  await handle.ready;
  try {
    const now = Date.now();
    handle.board.add({
      id: 'a1', provider: 'claude', station: 'model', label: 'Claude working', status: 'run',
      startedAt: now - 5e3, project: 'wt-hakkar-r12', detail: { kind: 'Claude turn', session: 'sess-a' },
    });
    handle.board.add({
      id: 'a2', provider: 'claude', station: 'shell', label: 'bash go test', status: 'err',
      startedAt: now - 20e3, endedAt: now - 19e3, project: 'wt-hakkar-r12',
      detail: { kind: 'Claude tool', session: 'sess-a' },
    });
    handle.board.add({
      id: 'b1', provider: 'codex', station: 'model', label: 'Codex working', status: 'run',
      startedAt: now - 10e3, project: 'wt-ony', detail: { kind: 'Codex turn', session: 'sess-b' },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/state`);
    const body = await res.json();
    assert.ok(Array.isArray(body.state.sessions), '/state sessions is a list');
    assert.strictEqual(body.state.sessions.length, 2);
    assert.ok(Array.isArray(body.state.errors), '/state errors is a list');
    assert.deepStrictEqual(body.state.errors[0], { count: 1, label: 'bash go test', project: 'wt-hakkar-r12' });

    const { dashboard, context } = await renderDashboard(body.state);
    assert.ok(dashboard.includes('SESSIONS'), 'the sessions panel is rendered');
    assert.ok(dashboard.includes('data-session="sess-a"'), 'a row carries the session key');
    assert.ok(dashboard.includes('FAILING · LAST HOUR'), 'the error spotlight is rendered');
    assert.ok(dashboard.includes('<b>1×</b> bash go test'), 'the spotlight shows the group');
    assert.ok(dashboard.includes('data-id="a1"') && dashboard.includes('data-id="b1"'), 'both sessions are in the feed');

    context.selectSession('sess-a');
    const filtered = context.document.querySelector('#dashboard').innerHTML;
    assert.ok(filtered.includes('data-id="a1"') && filtered.includes('data-id="a2"'), 'the clicked session keeps its events');
    assert.ok(!filtered.includes('data-id="b1"'), 'the other session is filtered out');
  } finally {
    await handle.close();
  }
});
