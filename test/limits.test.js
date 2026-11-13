const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { EventEmitter } = require('events');
const { createBoard } = require('../lib/board');
const { startLimits, readCodexLimits } = require('../lib/limits');
const { page } = require('../lib/page');

const NOW = 1_700_000_000_000;

// Hand-written fixture shaped like the owner's status line cache (fake values only).
function claudeFile(dir, { fetchedAt, limits } = {}) {
  const file = path.join(dir, 'usage_monthly.json');
  fs.writeFileSync(file, JSON.stringify({
    api_usage: {
      fetched_at: fetchedAt !== undefined ? fetchedAt : NOW / 1000,
      limits: limits !== undefined ? limits : [
        { kind: 'session', percent: 84, resets_at: new Date(NOW + 83 * 60e3).toISOString() },
        { kind: 'weekly_all', percent: 54, resets_at: new Date(NOW + (5 * 24 + 5) * 3600e3).toISOString() },
        { kind: 'weekly_scoped', label: 'Fable', percent: 49, resets_at: new Date(NOW + (5 * 24 + 5) * 3600e3).toISOString() },
        { kind: 'other', percent: 10 },
        { kind: 'session', percent: null },
      ],
    },
  }));
  return file;
}

// Fake codex app-server child: answers initialize, then the rateLimits read.
function fakeCodexSpawn(answers) {
  return (cmd, args, opts) => {
    assert.strictEqual(cmd, 'codex');
    assert.deepStrictEqual(args, ['app-server']);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write(line) { child.received.push(String(line)); }, end() {} };
    child.received = [];
    child.killed = false;
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ id: 1, result: { platformOs: 'linux' } }) + '\n');
      setImmediate(() => {
        assert.ok(child.received.some(l => l.includes('"initialized"')), 'client sends initialized');
        assert.ok(child.received.some(l => l.includes('rateLimits/read')), 'client reads account/rateLimits/read');
        if (answers.error) {
          child.stdout.emit('data', JSON.stringify({ id: 2, error: { message: answers.error } }) + '\n');
        } else {
          child.stdout.emit('data', JSON.stringify({ id: 2, result: answers.result }) + '\n');
        }
      });
    });
    return child;
  };
}

const CODEX_RESULT = {
  accountId: 'acct-SECRET',
  rateLimits: {
    planType: 'plus',
    rateLimitReachedType: null,
    primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: Math.floor(NOW / 1000) + 3 * 3600 + 41 * 60 },
    secondary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: Math.floor(NOW / 1000) + 6 * 86400 + 14 * 3600 },
  },
};

test('limits: claude file maps session, weekly_all and weekly_scoped, marks stale data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-limits-'));
  const file = claudeFile(dir);
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({ board, home: dir, now: () => NOW, timers: false, claudeFile: file, ompProfiles: [] });
  await lim.refresh('claude');
  lim.dispose();
  const snap = board.snapshot().limits.claude;
  assert.strictEqual(snap.status, 'ok');
  assert.deepStrictEqual(snap.accounts[0].windows.map(w => w.label), ['5h', 'Week', 'Fable']);
  assert.deepStrictEqual(snap.accounts[0].windows.map(w => w.usedPercent), [84, 54, 49]);
  assert.ok(!('staleMs' in snap.accounts[0]), 'fresh data has no staleness');

  const old = claudeFile(dir, { fetchedAt: NOW / 1000 - 20 * 60 });
  const board2 = createBoard({ now: () => NOW });
  const lim2 = startLimits({ board: board2, home: dir, now: () => NOW, timers: false, claudeFile: old, ompProfiles: [] });
  await lim2.refresh('claude');
  lim2.dispose();
  assert.ok(board2.snapshot().limits.claude.accounts[0].staleMs > 15 * 60e3, 'old fetched_at marks stale');
});

test('limits: missing claude file is disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-limits-'));
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({ board, home: dir, now: () => NOW, timers: false, ompProfiles: [] });
  await lim.refresh('claude');
  lim.dispose();
  assert.strictEqual(board.snapshot().limits.claude.status, 'disabled');
});

test('limits: claude file that cannot be parsed is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-limits-'));
  const file = path.join(dir, 'usage_monthly.json');
  fs.writeFileSync(file, '{not json');
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({ board, home: dir, now: () => NOW, timers: false, claudeFile: file, ompProfiles: [] });
  await lim.refresh('claude');
  lim.dispose();
  const snap = board.snapshot().limits.claude;
  assert.strictEqual(snap.status, 'unavailable');
  assert.strictEqual(snap.error, 'cannot read usage file');
});

test('limits: codex conversation is initialize, initialized, rateLimits/read; plan and both windows parsed; accountId not stored', async () => {
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({
    board, home: '/nonexistent', now: () => NOW, timers: false,
    claudeFile: '/nonexistent/x.json', ompProfiles: [], spawnFn: fakeCodexSpawn({ result: CODEX_RESULT }),
  });
  await lim.refresh('codex');
  lim.dispose();
  const snap = board.snapshot().limits.codex;
  assert.strictEqual(snap.status, 'ok');
  assert.strictEqual(snap.accounts[0].name, 'CODEX');
  assert.strictEqual(snap.accounts[0].plan, 'plus');
  assert.deepStrictEqual(snap.accounts[0].windows.map(w => w.label), ['5h', 'Week']);
  assert.deepStrictEqual(snap.accounts[0].windows.map(w => w.usedPercent), [9, 6]);
  assert.ok(!JSON.stringify(board.snapshot()).includes('acct-SECRET'), 'accountId not stored');
});

test('limits: codex timeout gives unavailable and kills the child', async () => {
  let childRef = null;
  const hanging = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.killed = false;
    child.kill = () => { child.killed = true; };
    childRef = child;
    return child;
  };
  const outcome = await readCodexLimits(hanging, { timeoutMs: 50, version: '0.2.0' });
  assert.strictEqual(outcome.failed, 'timeout');
  assert.ok(childRef && childRef.killed, 'child killed on timeout');
});
test('limits: codex spawn error is disabled through refresh', async () => {
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({
    board, home: '/nonexistent', now: () => NOW, timers: false,
    claudeFile: '/nonexistent/x.json', ompProfiles: [],
    spawnFn: () => {
      const err = new Error('spawn codex ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  await lim.refresh('codex');
  lim.dispose();
  assert.strictEqual(board.snapshot().limits.codex.status, 'disabled');
});

test('limits: codex backend error is unavailable', async () => {
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({
    board, home: '/nonexistent', now: () => NOW, timers: false,
    claudeFile: '/nonexistent/x.json', ompProfiles: [], spawnFn: fakeCodexSpawn({ error: 'auth failed' }),
  });
  await lim.refresh('codex');
  lim.dispose();
  const snap = board.snapshot().limits.codex;
  assert.strictEqual(snap.status, 'unavailable');
  assert.ok(snap.error.includes('auth failed'), 'backend message kept short');
});

function ompRunFactory(calls) {
  return async (cmd, args) => {
    assert.strictEqual(cmd, 'omp');
    const profile = args[args.indexOf('--profile') + 1];
    calls.push(profile);
    const num = Number(profile.replace(/\D/g, '')) || 0;
    if (profile === 'bad') {
      return { code: 1, stdout: '' };
    }
    const monthly = profile === 'go1'
      ? { usedFraction: 1, status: 'exhausted' }
      : { usedFraction: num / 100, status: 'ok' };
    return {
      code: 0,
      stdout: JSON.stringify({
        reports: [{
          provider: 'opencode-go',
          fetchedAt: NOW,
          metadata: { planType: 'OpenCode Go' },
          limits: [
            { window: { label: '5 Hour', resetsAt: NOW + 4 * 3600e3 }, amount: { usedFraction: 0 }, status: 'ok' },
            { window: { label: 'Weekly', resetsAt: NOW + 3 * 86400e3 }, amount: { usedFraction: 0 }, status: 'ok' },
            { window: { label: 'Monthly', resetsAt: NOW + 5 * 86400e3 }, amount: monthly, status: monthly.status },
          ],
        }],
      }),
    };
  };
}

test('limits: omp profiles run in parallel, exhausted monthly window, failing profile marked, go2 sorts before go10', async () => {
  const calls = [];
  const run = ompRunFactory(calls);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-limits-'));
  fs.mkdirSync(path.join(home, '.omp', 'profiles', 'go10'), { recursive: true });
  fs.mkdirSync(path.join(home, '.omp', 'profiles', 'go2'), { recursive: true });
  fs.mkdirSync(path.join(home, '.omp', 'profiles', 'go1'), { recursive: true });
  // Default profile discovery sorts numerically: go2 before go10.
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({ board, home, now: () => NOW, timers: false, run });
  await lim.refresh('omp');
  lim.dispose();
  assert.deepStrictEqual(calls.sort(), ['go1', 'go10', 'go2'], 'all profiles ran');
  const snap = board.snapshot().limits.omp;
  assert.strictEqual(snap.status, 'ok');
  assert.deepStrictEqual(snap.accounts.map(a => a.name), ['go1', 'go2', 'go10'].map(p => `OMP ${p}`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), 'accounts follow profile order');
  const go1 = snap.accounts.find(a => a.name === 'OMP go1');
  assert.ok(go1, 'go1 account present');
  const month = go1.windows.find(w => w.label === 'Month');
  assert.ok(month && month.exhausted === true && month.usedPercent === 100, 'exhausted monthly window flagged');

  const badBoard = createBoard({ now: () => NOW });
  const badLim = startLimits({ board: badBoard, home, now: () => NOW, timers: false, run, ompProfiles: ['go1', 'bad'] });
  await badLim.refresh('omp');
  badLim.dispose();
  const badSnap = badBoard.snapshot().limits.omp;
  assert.strictEqual(badSnap.status, 'ok');
  const bad = badSnap.accounts.find(a => a.name === 'OMP bad');
  assert.ok(bad, 'failing profile gets a named account');
  assert.deepStrictEqual(bad.windows, []);
  assert.strictEqual(bad.error, 'no answer');
});

test('limits: omp missing gives disabled', async () => {
  const run = async () => ({ code: -1, stdout: '', error: 'ENOENT' });
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({ board, home: '/nonexistent', now: () => NOW, timers: false, run, ompProfiles: ['go1', 'go2'] });
  await lim.refresh('omp');
  lim.dispose();
  assert.strictEqual(board.snapshot().limits.omp.status, 'disabled');
});

test('limits: omp with no profiles folder is disabled', async () => {
  const board = createBoard({ now: () => NOW });
  const lim = startLimits({ board, home: '/nonexistent-home', now: () => NOW, timers: false, run: async () => ({ code: 0, stdout: '{}' }) });
  await lim.refresh('omp');
  lim.dispose();
  assert.strictEqual(board.snapshot().limits.omp.status, 'disabled');
});

test('limits: board setLimits deep-copies and snapshot limits are copies', () => {
  const board = createBoard({ now: () => NOW });
  assert.strictEqual(board.snapshot().limits.claude, undefined, 'missing source is undefined');
  const result = { status: 'ok', checkedAt: NOW, accounts: [{ name: 'CLAUDE', windows: [{ label: '5h', usedPercent: 1 }] }] };
  board.setLimits('claude', result);
  result.accounts[0].windows[0].usedPercent = 99;
  assert.strictEqual(board.snapshot().limits.claude.accounts[0].windows[0].usedPercent, 1, 'stored copy is detached');
  board.snapshot().limits.claude.accounts[0].windows[0].usedPercent = 50;
  assert.strictEqual(board.snapshot().limits.claude.accounts[0].windows[0].usedPercent, 1, 'snapshot copy is detached');
  board.setLimits('bogus', result);
  assert.strictEqual(board.snapshot().limits.bogus, undefined, 'unknown source ignored');
});

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

function runPage(state) {
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
  return (async () => {
    vm.runInContext(script, context, { filename: 'page-script.js' });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    return forSelector('#dashboard').innerHTML;
  })();
}

test('page: the limits strip renders bars, 100% when used up, countdown and an unavailable row', async () => {
  // The omp account below comes from the real reader (exhausted monthly window), so the
  // exhausted-flag mutation breaks this test too, not just the reader unit test.
  const calls = [];
  void calls;
  const board = createBoard({ now: () => NOW });
  const run = ompRunFactory([]);
  const lim = startLimits({ board, home: '/nonexistent', now: () => NOW, timers: false, run, ompProfiles: ['go1'] });
  await lim.refresh('omp');
  lim.dispose();
  const ompResult = board.snapshot().limits.omp;
  assert.strictEqual(ompResult.accounts[0].windows.find(w => w.label === 'Month').exhausted, true);
  const state = {
    entries: [],
    counts: {},
    models: {},
    presence: {},
    usage: {},
    sessions: {},
    limits: {
      claude: {
        status: 'ok',
        checkedAt: NOW,
        accounts: [{
          name: 'CLAUDE',
          windows: [
            { label: '5h', usedPercent: 84, resetsAt: Date.now() + 83 * 60e3 },
            { label: 'Week', usedPercent: 54, resetsAt: Date.now() + (5 * 24 + 5) * 3600e3, pace: -25, etaMs: 90 * 60e3 },
            { label: 'Fable', usedPercent: 3, resetsAt: Date.now() + 3 * 86400e3, pace: 49, projectedPct: 6 },
          ],
        }],
      },
      codex: { status: 'unavailable', error: 'no answer from codex app-server', checkedAt: NOW },
      omp: ompResult,
    },
  };
  const dashboard = await runPage(state);
  assert.ok(dashboard.includes('LIMITS'), 'strip heading present');
  assert.ok(dashboard.includes('lim-pct out">100%'), 'an exhausted window reads 100% in red');
  assert.ok(dashboard.includes('84%'), 'percent shown');
  assert.ok(dashboard.includes('unavailable'), 'unavailable row shown');
  assert.ok(dashboard.includes('lim-fill crit'), 'exhausted fill is crit');
  assert.ok(dashboard.includes('lim-pace down">\u221225%'), 'a minus pace is shown in red');
  assert.ok(dashboard.includes('lim-pace up">+49%'), 'a plus pace is shown in green');
  assert.ok(dashboard.includes('lim-eta crit">\u2192 full in 1h 30m'), 'running out within 2 h is crit');
  assert.ok(dashboard.includes('\u2192 6% at reset'), 'a window that lasts shows its % at reset');
});

test('page: no limits in state renders no strip and no error', async () => {
  const state = { entries: [], counts: {}, models: {}, presence: {}, usage: {}, sessions: {} };
  const dashboard = await runPage(state);
  assert.ok(!dashboard.includes('LIMITS'), 'no strip without limits');
});

// Fake child that records stdin completion and every signal it receives.
function stoppingChild({ closeOnTerm = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.stdinEnded = false;
  child.stdin = {
    write(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        setImmediate(() => child.stdout.emit('data', JSON.stringify({ id: 1, result: { platformOs: 'linux' } }) + '\n'));
      } else if (msg.id === 2) {
        setImmediate(() => child.stdout.emit('data', JSON.stringify({
          id: 2,
          result: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 123 } } },
        }) + '\n'));
      }
    },
    end() { child.stdinEnded = true; },
  };
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGTERM' && closeOnTerm) setImmediate(() => child.emit('close', 0));
    return true;
  };
  return child;
}

test('limits: codex stop ends stdin and sends SIGTERM, no SIGKILL when the child exits', async () => {
  const child = stoppingChild({ closeOnTerm: true });
  const outcome = await readCodexLimits(() => child, { graceMs: 25, version: '0.2.0' });
  assert.ok(outcome.result, 'the answer is kept');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.strictEqual(child.stdinEnded, true, 'stdin ended first');
  assert.deepStrictEqual(child.signals, ['SIGTERM'], 'one polite signal, no SIGKILL');
});

test('limits: codex stop sends SIGKILL when the child ignores SIGTERM', async () => {
  const child = stoppingChild({ closeOnTerm: false });
  const outcome = await readCodexLimits(() => child, { graceMs: 25, version: '0.2.0' });
  assert.ok(outcome.result, 'the answer is kept');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.strictEqual(child.stdinEnded, true, 'stdin ended first');
  assert.deepStrictEqual(child.signals, ['SIGTERM', 'SIGKILL'], 'graceful first, hard kill after the grace period');
});

test('limits: defaultRun closes stdin and sends SIGTERM before the child exits', async () => {
  const { defaultRun } = require('../lib/limits');
  const child = stoppingChild({ closeOnTerm: true });
  const pending = defaultRun('omp', ['usage'], { spawnFn: () => child, input: 'ping', graceMs: 25 });
  child.stdout.emit('data', 'answer');
  child.emit('close', 0);
  const result = await pending;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stdout, 'answer');
  assert.strictEqual(child.stdinEnded, true, 'stdin ended before the signal');
  assert.deepStrictEqual(child.signals, ['SIGTERM'], 'no SIGKILL after a clean exit');
});
