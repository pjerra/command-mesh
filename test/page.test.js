const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { page } = require('../lib/page');

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

async function renderDashboard(state) {
  const html = page('body{}');
  const script = html.split('<script>')[1].split('</script>')[0];
  const stubs = new Map();
  const forSelector = sel => {
    if (!stubs.has(sel)) stubs.set(sel, stubElement());
    return stubs.get(sel);
  };
  const urls = [];
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
    console,
  };
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
  return { dashboard: dashboard.innerHTML, element: dashboard, context, urls };
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
