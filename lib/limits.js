'use strict';

// Account limit readers for the LIMITS strip. Three sources, each on its own schedule:
// claude reads a cache file written by the owner's status line script, codex talks to
// `codex app-server` over JSON-RPC (the read/refresh uses no quota beyond the process
// spawn), omp shells out to `omp usage` once per profile. Results go to
// board.setLimits(source, result). Fixtures in tests are hand-written with fake values.
// Nothing about the accounts is stored beyond the fields the strip shows: window labels,
// percents, reset times, plan names, staleness. codex accountId is never stored.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const agySource = require('./sources/agy');
const codexSource = require('./sources/codex');

const STALE_CLAUDE_MS = 15 * 60e3;
const DEFAULT_GRACE_MS = 2000;

// codex on PATH is a node wrapper whose native binary is a child process, so SIGKILL on
// the wrapper is not forwarded. Close stdin and ask politely first; only escalate when
// the wrapper is still around after the grace period.
function stopChild(child, graceMs = DEFAULT_GRACE_MS) {
  let closed = false;
  let timer = null;
  const onClose = () => {
    closed = true;
    clearTimeout(timer);
  };
  try {
    child.once?.('close', onClose);
  } catch {
    // A child without events is already as gone as it gets.
  }
  try {
    child.stdin.end();
  } catch {
    // stdin may already be closed.
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  const grace = Number(graceMs);
  timer = setTimeout(() => {
    if (closed) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, Number.isFinite(grace) && grace >= 0 ? grace : DEFAULT_GRACE_MS);
  timer.unref?.();
}

function defaultRun(cmd, args, { timeoutMs, input, graceMs, spawnFn } = {}) {
  const spawnChild = spawnFn || spawn;
  return new Promise(resolve => {
    let child;
    try {
      child = spawnChild(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: -1, stdout: '', error: 'ENOENT' });
      return;
    }
    let stdout = '';
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopChild(child, graceMs);
      resolve({ code, stdout, error });
    };
    const timer = setTimeout(() => finish(-1, 'ETIMEDOUT'), timeoutMs || 30000);
    child.on('error', err => finish(-1, err && err.code ? String(err.code) : 'spawn error'));
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.on('close', code => {
      finish(typeof code === 'number' ? code : -1);
    });
    if (input !== undefined) {
      try {
        child.stdin.write(input);
      } catch { /* ignore */ }
    }
    try {
      child.stdin.end();
    } catch { /* ignore */ }
  });
}

function defaultClaudeFile(home) {
  return path.join(home, '.claude', 'cache', 'usage_monthly.json');
}

// The second login's CODEX_HOME, when that folder exists: one more account row, read with its own
// `codex app-server` (env CODEX_HOME=...) so a failure or a spent quota on one never hides the other.
function defaultCodexAccounts(home) {
  const list = [{ label: 'CODEX', env: null }];
  const dir = codexSource.accountHome(home);
  if (dir) list.push({ label: 'CODEX 2', env: { CODEX_HOME: dir } });
  return list;
}

function defaultOmpProfiles(home) {
  let names;
  try {
    names = fs.readdirSync(path.join(home, '.omp', 'profiles'));
  } catch {
    return null;
  }
  const collator = new Intl.Collator(undefined, { numeric: true });
  return names
    .filter(n => {
      try {
        return fs.statSync(path.join(home, '.omp', 'profiles', n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort(collator.compare);
}

// kind session -> 5h; weekly_all -> Week; weekly_scoped -> its own label ("Fable"), a 7 day window.
function claudeLabel(item) {
  if (item.kind === 'session') return '5h';
  if (item.kind === 'weekly_all') return 'Week';
  if (item.kind === 'weekly_scoped') return String(item.label || 'Scoped');
  return null;
}

function readClaudeFile({ file, now }) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'disabled', checkedAt: now() };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: 'unavailable', error: 'cannot read usage file', checkedAt: now() };
  }
  try {
    const usage = data && data.api_usage;
    const items = usage && Array.isArray(usage.limits) ? usage.limits : null;
    if (!items) return { status: 'unavailable', error: 'cannot read usage file', checkedAt: now() };
    const windows = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (item.percent === null || item.percent === undefined) continue;
      const label = claudeLabel(item);
      if (!label) continue;
      const w = { label, usedPercent: Math.round(Number(item.percent)) };
      w.windowMs = item.kind === 'session' ? 5 * 3600e3 : 7 * 24 * 3600e3;
      if (typeof item.resets_at === 'string' && item.resets_at) {
        const ms = Date.parse(item.resets_at);
        if (Number.isFinite(ms)) w.resetsAt = ms;
      }
      windows.push(w);
    }
    let staleMs;
    const fetched = usage && usage.fetched_at;
    if (typeof fetched === 'number' && Number.isFinite(fetched)) {
      const age = now() - fetched * 1000;
      if (age > STALE_CLAUDE_MS) staleMs = Math.round(age);
    }
    const account = { name: 'CLAUDE', windows };
    if (staleMs !== undefined) account.staleMs = staleMs;
    return { status: 'ok', checkedAt: now(), accounts: [account] };
  } catch {
    return { status: 'unavailable', error: 'cannot read usage file', checkedAt: now() };
  }
}

function codexWindowLabel(mins) {
  if (mins === 300) return '5h';
  if (mins === 10080) return 'Week';
  if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) return 'window';
  if (mins < 60) return `${mins}m`;
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

// The JSON-RPC conversation: initialize -> initialized + account/rateLimits/read.
// spawnFn defaults to child_process.spawn and is injected in tests. Only usedPercent,
// windowDurationMins, resetsAt, planType and the reached flag are read; accountId and
// everything else are dropped on the floor. `env` carries CODEX_HOME for the second login, so the
// one call answers for that account only.
function readCodexLimits(spawnFn, { timeoutMs = 15000, version, graceMs, env } = {}) {
  const spawnChild = spawnFn || spawn;
  return new Promise(resolve => {
    let child;
    try {
      const options = { stdio: ['pipe', 'pipe', 'ignore'] };
      if (env) options.env = { ...process.env, ...env };
      child = spawnChild('codex', ['app-server'], options);
    } catch (err) {
      resolve({ failed: 'spawn', error: err && err.code ? String(err.code) : 'spawn error' });
      return;
    }
    let done = false;
    let buffer = '';
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopChild(child, graceMs);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ failed: 'timeout' }), timeoutMs);
    const write = line => {
      try {
        child.stdin.write(line + '\n');
      } catch {
        finish({ failed: 'write' });
      }
    };
    let pkgVersion = version;
    if (!pkgVersion) {
      try {
        pkgVersion = require('../package.json').version;
      } catch {
        pkgVersion = '0.0.0';
      }
    }
    const onData = chunk => {
      buffer += String(chunk);
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && msg.id === 1 && msg.result !== undefined) {
          write('{"method":"initialized"}');
          write('{"id":2,"method":"account/rateLimits/read"}');
        } else if (msg && msg.id === 2) {
          if (msg.error) {
            finish({ failed: 'backend', message: msg.error && msg.error.message ? String(msg.error.message) : 'codex error' });
            return;
          }
          finish({ result: msg.result && typeof msg.result === 'object' ? msg.result : {} });
          return;
        }
      }
    };
    try {
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', onData);
      if (child.stderr && typeof child.stderr.on === 'function') { /* stderr ignored */ }
      child.on('error', () => finish({ failed: 'spawn' }));
      child.on('close', () => finish({ failed: 'closed' }));
    } catch {
      finish({ failed: 'spawn' });
      return;
    }
    write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'command-mesh', version: pkgVersion } } }));
  });
}

function parseCodexResult(result, now, name = 'CODEX') {
  const rl = result && typeof result === 'object' && result.rateLimits && typeof result.rateLimits === 'object'
    ? result.rateLimits
    : {};
  const reached = rl.rateLimitReachedType;
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (!w || typeof w !== 'object') continue;
    const used = w.usedPercent;
    if (used === null || used === undefined) continue;
    const pct = Math.round(Number(used));
    const out = { label: codexWindowLabel(w.windowDurationMins), usedPercent: pct };
    if (typeof w.windowDurationMins === 'number' && w.windowDurationMins > 0) out.windowMs = w.windowDurationMins * 60e3;
    if (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)) out.resetsAt = w.resetsAt * 1000;
    if (reached !== null && reached !== undefined && pct >= 100) out.exhausted = true;
    windows.push(out);
  }
  const account = { name, windows };
  if (rl.planType) account.plan = String(rl.planType);
  return { status: 'ok', checkedAt: now(), accounts: [account] };
}

function ompWindowLabel(label) {
  if (label === '5 Hour') return '5h';
  if (label === 'Weekly') return 'Week';
  if (label === 'Monthly') return 'Month';
  return String(label);
}

async function readOmpProfile(run, profile, now) {
  let res;
  try {
    res = await run('omp', ['--profile', profile, 'usage', '-p', 'opencode-go', '--json'], { timeoutMs: 60000 });
  } catch {
    res = { code: -1, stdout: '' };
  }
  const failed = !res || res.code !== 0;
  const enoent = res && res.code === -1 && res.error && /ENOENT/i.test(String(res.error));
  let reports = null;
  if (!failed) {
    try {
      const data = JSON.parse(String(res.stdout || ''));
      reports = data && Array.isArray(data.reports) ? data.reports : null;
    } catch {
      reports = null;
    }
  }
  let report = null;
  if (Array.isArray(reports)) {
    report = reports.find(r => r && r.provider === 'opencode-go') || null;
  }
  if (!report) {
    return { account: null, failed: true, missing: enoent };
  }
  const windows = [];
  const limits = Array.isArray(report.limits) ? report.limits : [];
  for (const lim of limits) {
    if (!lim || typeof lim !== 'object') continue;
    const win = lim.window && typeof lim.window === 'object' ? lim.window : {};
    const amount = lim.amount && typeof lim.amount === 'object' ? lim.amount : {};
    const frac = Number(amount.usedFraction);
    if (!Number.isFinite(frac)) continue;
    const w = { label: ompWindowLabel(win.label), usedPercent: Math.round(frac * 100) };
    if (typeof win.resetsAt === 'number' && Number.isFinite(win.resetsAt)) w.resetsAt = win.resetsAt;
    if (lim.status === 'exhausted') w.exhausted = true;
    windows.push(w);
  }
  const account = { name: `OMP ${profile}`, windows };
  const fetched = report.fetchedAt;
  if (typeof fetched === 'number' && Number.isFinite(fetched)) {
    const age = now() - fetched;
    if (age > STALE_CLAUDE_MS) account.staleMs = Math.round(age);
  }
  return { account, failed: false, missing: false };
}

// Antigravity CLI: `agy -p /usage --output-format json` answers from the quota service without
// calling a model (0 tokens). Each group (Gemini models; Claude and GPT models) has a 5h and a
// weekly bucket with the fraction remaining; a plan without a five-hour bucket simply has the
// weekly one. Only group names, fractions and reset times are kept. One call runs per account
// home (the second through `env HOME=...`), so each account gets its own two group rows.
const AGY_GROUP = { 'Gemini Models': 'gemini', 'Claude and GPT models': 'claude·gpt' };
function agyWindowLabel(window) {
  if (window === '5h') return '5h';
  if (window === 'weekly') return 'Week';
  return String(window || '').slice(0, 8);
}

function parseAgyUsage(stdout, account = 'acct1') {
  let data;
  try {
    data = JSON.parse(String(stdout || ''));
  } catch {
    return null;
  }
  const groups = data && data.command && data.command.data && Array.isArray(data.command.data.groups) ? data.command.data.groups : null;
  if (!groups) return null;
  const accounts = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    const windows = [];
    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const left = Number(bucket.remaining_fraction);
      if (!Number.isFinite(left)) continue;
      const used = Math.min(100, Math.max(0, Math.round((1 - left) * 100)));
      const w = { label: agyWindowLabel(bucket.window), usedPercent: used };
      const reset = Date.parse(String(bucket.reset_time || ''));
      if (Number.isFinite(reset)) w.resetsAt = reset;
      if (w.label === '5h') w.windowMs = 5 * 3600e3;
      if (w.label === 'Week') w.windowMs = 7 * 24 * 3600e3;
      if (left <= 0) w.exhausted = true;
      windows.push(w);
    }
    // 5h first, then Week, like the other rows.
    windows.sort((a, b) => (a.label === '5h' ? 0 : 1) - (b.label === '5h' ? 0 : 1));
    const plan = AGY_GROUP[group.name] || String(group.name || '').slice(0, 20);
    accounts.push({ name: `AGY ${account}`, plan, windows });
  }
  return accounts.length ? accounts : null;
}

async function readAgyLimits(run, binary, account = { label: 'acct1', home: null, primary: true }) {
  const args = ['-p', '/usage', '--output-format', 'json', '--print-timeout', '40s'];
  let res;
  try {
    // Account 2+ runs the same CLI under its own HOME; the wrapper `agy2` is exactly that env call.
    res = account.primary || !account.home
      ? await run(binary, args, { timeoutMs: 60000 })
      : await run('env', [`HOME=${account.home}`, binary, ...args], { timeoutMs: 60000 });
  } catch {
    res = { code: -1, stdout: '' };
  }
  const enoent = res && res.code === -1 && res.error && /ENOENT/i.test(String(res.error));
  if (enoent) return { missing: true };
  const accounts = res && res.code === 0 ? parseAgyUsage(res.stdout, account.label) : null;
  return accounts ? { accounts } : { failed: true };
}

function defaultAgyBinary(home) {
  const local = require('path').join(home, '.local', 'bin', 'agy');
  try {
    require('fs').accessSync(local, require('fs').constants.X_OK);
    return local;
  } catch {
    return 'agy';
  }
}

function startLimits({ board, home, now = Date.now, timers = true, run = defaultRun, claudeFile, ompProfiles, agyAccounts, codexAccounts, spawnFn, agyBinary } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const baseHome = home || require('os').homedir();
  const file = claudeFile || defaultClaudeFile(home || require('os').homedir());
  let profiles = ompProfiles;
  if (profiles === undefined) profiles = defaultOmpProfiles(home || require('os').homedir());
  const spawnChild = spawnFn || spawn;
  const agy = agyBinary || defaultAgyBinary(home || require('os').homedir());
  let agyList = agyAccounts;
  if (agyList === undefined) {
    try {
      agyList = agySource.accounts(baseHome);
    } catch {
      agyList = [];
    }
  }
  if (!Array.isArray(agyList) || agyList.length === 0) agyList = [{ label: 'acct1', home: baseHome, primary: true }];
  let codexList = codexAccounts;
  if (codexList === undefined) {
    try {
      codexList = defaultCodexAccounts(baseHome);
    } catch {
      codexList = [{ label: 'CODEX', env: null }];
    }
  }
  if (!Array.isArray(codexList) || codexList.length === 0) codexList = [{ label: 'CODEX', env: null }];
  const busy = { claude: false, codex: false, omp: false, gemini: false };
  let claudeTimer = null;
  let codexTimer = null;
  let ompTimer = null;
  let agyTimer = null;

  async function refreshClaude() {
    if (busy.claude) return;
    busy.claude = true;
    try {
      board.setLimits('claude', readClaudeFile({ file, now: clock }));
    } catch {
      try {
        board.setLimits('claude', { status: 'unavailable', error: 'cannot read usage file', checkedAt: clock() });
      } catch { /* board must never break the reader */ }
    } finally {
      busy.claude = false;
    }
  }

  async function refreshCodex() {
    if (busy.codex) return;
    busy.codex = true;
    try {
      const settled = await Promise.all(codexList.map(account => readCodexLimits(spawnChild, { timeoutMs: 15000, env: account.env })));
      const accounts = [];
      let rows = 0;
      let missing = 0;
      let firstError = '';
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const label = codexList[i].label;
        if (!outcome.failed) {
          const parsed = parseCodexResult(outcome.result, clock, label);
          rows += parsed.accounts.length;
          accounts.push(...parsed.accounts);
          continue;
        }
        let error;
        if (outcome.failed === 'spawn') {
          missing += 1;
          error = 'codex not found';
        } else if (outcome.failed === 'backend') {
          error = String(outcome.message || 'codex error').slice(0, 60);
        } else {
          error = 'no answer from codex app-server';
        }
        if (!firstError && outcome.failed !== 'spawn') firstError = error;
        // One account's failed call must not hide the other account's rows.
        accounts.push({ name: label, windows: [], error });
      }
      if (rows === 0 && missing === settled.length) {
        board.setLimits('codex', { status: 'disabled', checkedAt: clock() });
      } else if (rows === 0) {
        board.setLimits('codex', { status: 'unavailable', error: firstError || 'no answer from codex app-server', checkedAt: clock() });
      } else {
        board.setLimits('codex', { status: 'ok', checkedAt: clock(), accounts });
      }
    } catch {
      try {
        board.setLimits('codex', { status: 'unavailable', error: 'no answer from codex app-server', checkedAt: clock() });
      } catch { /* board must never break the reader */ }
    } finally {
      busy.codex = false;
    }
  }

  async function refreshOmp() {
    if (busy.omp) return;
    busy.omp = true;
    try {
      if (!profiles || profiles.length === 0) {
        board.setLimits('omp', { status: 'disabled', checkedAt: clock() });
        return;
      }
      const settled = await Promise.all(profiles.map(p => readOmpProfile(run, p, clock)));
      const accounts = [];
      let missing = 0;
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.account) accounts.push(s.account);
        else if (s.missing) missing += 1;
        else accounts.push({ name: `OMP ${profiles[i]}`, windows: [], error: 'no answer' });
      }
      if (accounts.length === 0 && missing > 0) {
        board.setLimits('omp', { status: 'disabled', checkedAt: clock() });
        return;
      }
      if (accounts.length === 0) {
        board.setLimits('omp', { status: 'unavailable', error: 'no answer', checkedAt: clock() });
        return;
      }
      board.setLimits('omp', { status: 'ok', checkedAt: clock(), accounts });
    } catch {
      try {
        board.setLimits('omp', { status: 'unavailable', error: 'no answer', checkedAt: clock() });
      } catch { /* board must never break the reader */ }
    } finally {
      busy.omp = false;
    }
  }

  async function refreshAgy() {
    if (busy.gemini) return;
    busy.gemini = true;
    try {
      const settled = await Promise.all(agyList.map(account => readAgyLimits(run, agy, account)));
      const accounts = [];
      let missing = 0;
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.missing) {
          missing += 1;
          continue;
        }
        if (outcome.failed) {
          // One account's failed call must not hide the other account's rows.
          accounts.push({ name: `AGY ${agyList[i].label}`, windows: [], error: 'no answer' });
          continue;
        }
        accounts.push(...outcome.accounts);
      }
      if (accounts.length === 0 && missing === settled.length) board.setLimits('gemini', { status: 'disabled', checkedAt: clock() });
      else if (accounts.length === 0) board.setLimits('gemini', { status: 'unavailable', error: 'no answer from agy', checkedAt: clock() });
      else board.setLimits('gemini', { status: 'ok', checkedAt: clock(), accounts });
    } catch {
      try {
        board.setLimits('gemini', { status: 'unavailable', error: 'no answer from agy', checkedAt: clock() });
      } catch { /* board must never break the reader */ }
    } finally {
      busy.gemini = false;
    }
  }

  async function refresh(which) {
    if (which === 'claude') await refreshClaude();
    else if (which === 'codex') await refreshCodex();
    else if (which === 'omp') await refreshOmp();
    else if (which === 'gemini') await refreshAgy();
    else await Promise.all([refreshClaude(), refreshCodex(), refreshOmp(), refreshAgy()]);
  }

  if (timers) {
    claudeTimer = setInterval(() => { refreshClaude().catch(() => {}); }, 60e3);
    codexTimer = setInterval(() => { refreshCodex().catch(() => {}); }, 180e3);
    ompTimer = setInterval(() => { refreshOmp().catch(() => {}); }, 300e3);
    claudeTimer.unref?.();
    codexTimer.unref?.();
    ompTimer.unref?.();
    agyTimer = setInterval(() => { refreshAgy().catch(() => {}); }, 300e3);
    agyTimer.unref?.();
    const agyFirst = setTimeout(() => { refreshAgy().catch(() => {}); }, 4000);
    agyFirst.unref?.();
    // First runs staggered so startup stays cheap; codex/omp behind short delays.
    const codexFirst = setTimeout(() => { refreshCodex().catch(() => {}); }, 2000);
    const ompFirst = setTimeout(() => { refreshOmp().catch(() => {}); }, 3000);
    codexFirst.unref?.();
    ompFirst.unref?.();
    // Claude first run happens now (cheap file read) via refresh below.
    refreshClaude().catch(() => {});
  }

  return {
    refresh,
    dispose() {
      clearInterval(claudeTimer);
      clearInterval(codexTimer);
      clearInterval(ompTimer);
      clearInterval(agyTimer);
    },
  };
}

module.exports = { startLimits, readCodexLimits, defaultRun, parseAgyUsage };
