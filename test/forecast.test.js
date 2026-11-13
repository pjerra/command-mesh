const { test } = require('node:test');
const assert = require('node:assert');
const { createBoard } = require('../lib/board');
const { createForecast, paceOf, windowMsOf } = require('../lib/forecast');

const H = 3600e3;
const D = 24 * H;

test('forecast: window length from codex minutes, short labels, week and calendar month', () => {
  assert.strictEqual(windowMsOf({ label: '5h' }), 5 * H);
  assert.strictEqual(windowMsOf({ label: 'Week' }), 7 * D);
  assert.strictEqual(windowMsOf({ label: 'Fable week' }), 7 * D);
  assert.strictEqual(windowMsOf({ label: 'window', windowMs: 42 * 60e3 }), 42 * 60e3);
  const reset = new Date(2026, 11, 3, 10).getTime(); // 3 Dec: the window started 3 Nov (30 days).
  assert.strictEqual(windowMsOf({ label: 'Month', resetsAt: reset }), reset - new Date(2026, 10, 3, 10).getTime());
  assert.strictEqual(windowMsOf({ label: 'mystery' }), 0);
});

test('forecast: pace and projection match the status line numbers', () => {
  const t = 1_700_000_000_000;
  // 5h window, 2h17m left, 22 % used: 54 % of the time passed -> +32, about 40 % at reset.
  const five = paceOf({ label: '5h', usedPercent: 22, resetsAt: t + (2 * 60 + 17) * 60e3 }, t);
  assert.strictEqual(five.pace, 32);
  assert.strictEqual(five.projectedPct, 40);
  assert.ok(!('etaMs' in five));

  // Week, 3d7h left, 63 % used: 53 % passed -> -10; the average rate fills it ~2d4h from now.
  const week = paceOf({ label: 'Week', usedPercent: 63, resetsAt: t + (3 * 24 + 7) * H }, t);
  assert.strictEqual(week.pace, -10);
  assert.ok(!('projectedPct' in week));
  const elapsed = 7 * D - (3 * 24 + 7) * H;
  assert.ok(Math.abs(week.etaMs - (elapsed * 37) / 63) < 1000, `eta was ${week.etaMs}`);
  assert.ok(week.etaMs < (3 * 24 + 7) * H, 'it runs out before the reset');
});

test('forecast: no projection early in a window, when used up, or without a reset', () => {
  const t = 1_700_000_000_000;
  const early = paceOf({ label: '5h', usedPercent: 10, resetsAt: t + 5 * H - 5 * 60e3 }, t);
  assert.ok(early && typeof early.pace === 'number');
  assert.ok(!('projectedPct' in early) && !('etaMs' in early), 'five minutes into 5h is too early');
  const out = paceOf({ label: 'Week', usedPercent: 100, exhausted: true, resetsAt: t + D }, t);
  assert.ok(!('projectedPct' in out) && !('etaMs' in out));
  const idle = paceOf({ label: 'Week', usedPercent: 0, resetsAt: t + D }, t);
  assert.strictEqual(idle.projectedPct, 0);
  assert.strictEqual(paceOf({ label: 'Week', usedPercent: 5 }, t), null);
  assert.strictEqual(paceOf({ label: 'Week', usedPercent: 5, resetsAt: t - 1 }, t), null);
});

test('forecast: the board decorates each limit window in the snapshot', () => {
  const t = 1_700_000_000_000;
  const forecast = createForecast({ now: () => t });
  const board = createBoard({ now: () => t, forecast });
  board.setLimits('claude', {
    status: 'ok',
    checkedAt: t,
    accounts: [{ name: 'CLAUDE', windows: [{ label: '5h', usedPercent: 22, resetsAt: t + (2 * 60 + 17) * 60e3 }] }],
  });
  const window = board.snapshot().limits.claude.accounts[0].windows[0];
  assert.strictEqual(window.pace, 32);
  assert.strictEqual(window.projectedPct, 40);
});
