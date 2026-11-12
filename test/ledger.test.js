'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createLedger } = require('../lib/usage/ledger');

function record(provider, at, cost, extra) {
  return {
    provider,
    at,
    model: 'demo',
    input: 100,
    cacheRead: 200,
    cacheWrite5m: 30,
    cacheWrite1h: 10,
    output: 50,
    cost,
    rough: false,
    key: `${provider}:${at}:${cost}`,
    ...extra,
  };
}

test('ledger: today/week/month boundaries in local time', () => {
  const now = new Date(2026, 10, 12, 15, 30, 0, 0).getTime(); // Thu 12 Nov 2026
  const ledger = createLedger({ now: () => now });
  const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();

  ledger.add(record('claude', at(11, 23, 59), 1)); // yesterday, 23:59
  ledger.add(record('claude', at(8, 23, 59), 2)); // Sunday before this week
  ledger.add(record('claude', at(9, 0, 0), 4)); // Monday 00:00, first minute of the week
  ledger.add(record('claude', at(31 - 1, 23, 59), 8)); // 31 Oct, previous month
  ledger.add(record('claude', at(1, 0, 0), 16)); // 1 Nov, first minute of the month
  ledger.add(record('claude', at(12, 0, 1), 32)); // today, 00:01

  const periods = ledger.periods(now);
  assert.strictEqual(periods.today.per.total.cost, 32, 'today starts at local midnight');
  assert.strictEqual(periods.week.per.total.cost, 4 + 1 + 32, 'the week starts Monday 00:00, Sunday is out');
  assert.strictEqual(periods.month.per.total.cost, 2 + 4 + 1 + 16 + 32, 'the month starts on the 1st');
  assert.strictEqual(periods.hour.per.total.cost, 0, 'nothing happened in the last hour');

  // A record at exactly Monday 00:00 is inside the week, one minute earlier is not.
  const before = createLedger({ now: () => now });
  before.add(record('omp', at(8, 23, 59), 5));
  assert.strictEqual(before.periods(now).week.per.total.cost, 0);
  const edge = createLedger({ now: () => now });
  edge.add(record('omp', at(9, 0, 0), 5));
  assert.strictEqual(edge.periods(now).week.per.total.cost, 5);
});

test('ledger: hour tab has 12 five-minute bars and today has 24 hourly bars', () => {
  const now = new Date(2026, 10, 12, 15, 32, 0, 0).getTime();
  const ledger = createLedger({ now: () => now });
  const five = 5 * 60e3;
  for (let i = 0; i < 12; i++) {
    ledger.add(record('claude', now - i * five - 1000, i + 1));
  }
  ledger.add(record('codex', now - 3 * 60 * 60e3, 7, { rough: true }));

  const periods = ledger.periods(now);
  assert.strictEqual(periods.hour.bars.length, 12, 'hour has 12 bars');
  assert.strictEqual(periods.today.bars.length, 24, 'today has 24 hourly bars');
  assert.strictEqual(periods.week.bars.length, 7, 'week has one bar per day');
  assert.strictEqual(periods.month.bars.length, 30, 'November has 30 daily bars');
  assert.ok(periods.hour.per.total.cost > 0, 'the hour sums its five-minute bars');
  assert.ok(periods.hour.per.claude.tokens > 0);
  assert.strictEqual(periods.week.per.codex.rough, true, 'rough survives aggregation');
  assert.ok(periods.today.per.total.tokens > 0);

  // Buckets survive a cache round-trip.
  const copy = createLedger({ now: () => now });
  copy.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.strictEqual(copy.periods(now).hour.per.total.cost, periods.hour.per.total.cost);
  assert.strictEqual(copy.periods(now).month.per.total.cost, periods.month.per.total.cost);
});
