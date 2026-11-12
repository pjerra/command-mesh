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
  const context = {
    document: {
      querySelector: sel => forSelector(sel),
      querySelectorAll: () => [],
      createElement: () => stubElement(),
    },
    fetch: async () => ({ json: async () => ({ state, svg: '<svg/>' }) }),
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
  return forSelector('#dashboard').innerHTML;
}

test('page: the script renders the telemetry panel without throwing', async () => {
  const dashboard = await renderDashboard({
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
  const dashboard = await renderDashboard({
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
    dashboard.includes('title="Claude $1.24 · Codex ~$0.40 · OMP $0.12"'),
    'the tooltip names each provider and its cost',
  );
  assert.ok(!dashboard.includes('OMP cost'), 'the old OMP-only KPI is gone');

  const empty = await renderDashboard({ entries: [], usage: {}, sessions: {} });
  assert.ok(empty.includes('<span>Est. cost</span><b>--</b>'), 'nothing yet shows --');
});
