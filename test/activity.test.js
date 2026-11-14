const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createActivity } = require('../lib/activity');
const { createBoard } = require('../lib/board');

const NOW = 1_700_000_040_000; // a whole minute
const MINUTE = 60e3;
const HOUR = 3600e3;

function sum(bars, provider) {
  return bars.reduce((total, bar) => total + bar.per[provider], 0);
}

test('activity: ranges give 30/24/32/48 bars with the right spans and counts per agent', () => {
  const activity = createActivity({ now: () => NOW });
  activity.add({ provider: 'claude', station: 'files', startedAt: NOW - 30e3 });
  activity.add({ provider: 'codex', station: 'shell', startedAt: NOW - 90e3 });
  activity.add({ provider: 'omp', station: 'web', startedAt: NOW - 2 * HOUR + 30e3 });

  const half = activity.bars('30m', NOW);
  assert.strictEqual(half.length, 30);
  assert.deepStrictEqual(half[29], {
    from: NOW - MINUTE,
    to: NOW,
    per: { claude: 1, codex: 0, omp: 0, gemini: 0 },
    stations: { files: 1 },
  });
  assert.deepStrictEqual(half[28], {
    from: NOW - 2 * MINUTE,
    to: NOW - MINUTE,
    per: { claude: 0, codex: 1, omp: 0, gemini: 0 },
    stations: { shell: 1 },
  });
  assert.strictEqual(half[0].from, NOW - 30 * MINUTE);

  const two = activity.bars('2h', NOW);
  assert.strictEqual(two.length, 24);
  assert.strictEqual(two[0].from, NOW - 24 * 5 * MINUTE);
  assert.strictEqual(two[0].to, NOW - 23 * 5 * MINUTE);
  assert.deepStrictEqual(two[0].per, { claude: 0, codex: 0, omp: 1, gemini: 0 });
  assert.deepStrictEqual(two[23].per, { claude: 1, codex: 1, omp: 0, gemini: 0 });
  assert.strictEqual(sum(two, 'claude'), 1);
  assert.strictEqual(sum(two, 'codex'), 1);
  assert.strictEqual(sum(two, 'omp'), 1);

  const eight = activity.bars('8h', NOW);
  assert.strictEqual(eight.length, 32);
  assert.strictEqual(eight[1].to - eight[1].from, 15 * MINUTE);
  assert.strictEqual(eight[0].from, NOW - 32 * 15 * MINUTE);

  const day = activity.bars('24h', NOW);
  assert.strictEqual(day.length, 48);
  assert.strictEqual(day[1].to - day[1].from, 30 * MINUTE);
  assert.strictEqual(day[0].from, NOW - 24 * HOUR);
  assert.strictEqual(sum(day, 'claude'), 1);
  assert.strictEqual(sum(day, 'codex'), 1);
  assert.strictEqual(sum(day, 'omp'), 1);
  assert.deepStrictEqual(day[47].stations, { files: 1, shell: 1 });
  assert.deepStrictEqual(day.find(bar => bar.per.omp === 1).stations, { web: 1 });

  const bars = activity.bars('nope', NOW);
  assert.strictEqual(bars.length, 30, 'an unknown range falls back to 30m');
});

test('activity: minutes older than 24 h are dropped; restart from the saved file keeps the counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-activity-'));
  const file = path.join(dir, 'activity-v1.json');
  let clock = NOW;
  const activity = createActivity({ now: () => clock, file });
  assert.strictEqual(activity.add({ provider: 'claude', station: 'files', startedAt: NOW - 5 * MINUTE }), true);
  activity.add({ provider: 'codex', station: 'shell', startedAt: NOW - 6 * HOUR });
  assert.strictEqual(activity.add({ provider: 'omp', station: 'web', startedAt: NOW - 25 * HOUR }), false, 'an old entry is ignored');
  assert.strictEqual(activity.save(true), true);
  assert.ok(fs.existsSync(file));

  const restored = createActivity({ now: () => clock, file });
  const bars = restored.bars('24h', NOW);
  assert.strictEqual(sum(bars, 'claude'), 1);
  assert.strictEqual(sum(bars, 'codex'), 1);
  assert.strictEqual(sum(bars, 'omp'), 0);

  clock = NOW + 25 * HOUR;
  restored.add({ provider: 'omp', station: 'web', startedAt: clock - 30e3 });
  assert.strictEqual(restored.save(true), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(saved.minutes), [String(Math.floor((clock - 30e3) / MINUTE) * MINUTE)], 'only the fresh minute survives the save');
});

test('activity: board.add feeds the buckets', () => {
  const activity = createActivity({ now: () => NOW });
  const board = createBoard({ now: () => NOW, activity });
  board.add({
    id: 'claude-tool-t1', provider: 'claude', station: 'files', label: 'Read a/b.js',
    status: 'run', startedAt: NOW - 30e3, project: 'demo', detail: {},
  });
  board.add({
    id: 'claude-tool-t1', provider: 'claude', station: 'files', label: 'Read a/b.js',
    status: 'run', startedAt: NOW - 30e3, project: 'demo', detail: {},
  });
  const bars = activity.bars('30m', NOW);
  assert.deepStrictEqual(bars[29].per, { claude: 1, codex: 0, omp: 0, gemini: 0 });
});
