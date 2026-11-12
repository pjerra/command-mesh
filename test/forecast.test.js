const { test } = require('node:test');
const assert = require('node:assert');
const { createBoard } = require('../lib/board');
const { createForecast } = require('../lib/forecast');

function limits(pct, resetsAt) {
  return {
    status: 'ok',
    checkedAt: 0,
    accounts: [{ name: 'CLAUDE', windows: [{ label: '5h', usedPercent: pct, resetsAt }] }],
  };
}

test('limits forecast: slope from samples gives full-in, nothing when it resets first or rate <= 0', () => {
  const t0 = 1_700_000_000_000;
  let t = t0;
  const now = () => t;

  // 20 -> 40 percent over ten minutes is 2 points a minute: 30 minutes to full.
  const resets = t0 + 2 * 3600e3;
  const forecast = createForecast({ now });
  const board = createBoard({ now, forecast });
  board.setLimits('claude', limits(20, resets));
  t = t0 + 10 * 60e3;
  board.setLimits('claude', limits(40, resets));
  const window = board.snapshot().limits.claude.accounts[0].windows[0];
  assert.ok(Math.abs(window.etaMs - 30 * 60e3) < 60e3, `eta was ${window.etaMs}`);
  assert.ok(window.etaMs < resets - t, 'the forecast lands before the reset');

  // The reset arrives first: 60 percent at 1 point a minute needs 40 minutes, the reset is 2 away.
  let t2 = t0;
  const early = t0 + 12 * 60e3;
  const forecast2 = createForecast({ now: () => t2 });
  const board2 = createBoard({ now: () => t2, forecast: forecast2 });
  board2.setLimits('claude', limits(50, early));
  t2 = t0 + 10 * 60e3;
  board2.setLimits('claude', limits(60, early));
  const window2 = board2.snapshot().limits.claude.accounts[0].windows[0];
  assert.ok(!('etaMs' in window2), 'no forecast when the window resets first');

  // Usage going down gives no forecast either.
  let t3 = t0;
  const forecast3 = createForecast({ now: () => t3 });
  const board3 = createBoard({ now: () => t3, forecast: forecast3 });
  board3.setLimits('claude', limits(50, resets));
  t3 = t0 + 10 * 60e3;
  board3.setLimits('claude', limits(40, resets));
  const window3 = board3.snapshot().limits.claude.accounts[0].windows[0];
  assert.ok(!('etaMs' in window3), 'a flat or falling window has no forecast');
});
