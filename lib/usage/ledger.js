'use strict';

// Persistent usage ledger: cost and tokens per agent, bucketed by local hour, plus five minute
// buckets for the current three hours. The page asks for hour / today / week / month periods; this
// module owns the local-time boundaries and the bar layout.

const PROVIDERS = ['claude', 'codex', 'omp'];
const FIVE = 5 * 60e3;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const KEEP_HOUR_MS = 40 * DAY;
const KEEP_FIVE_MS = 3 * HOUR;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = MONTHS.map(name => name.slice(0, 3));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localHourStart(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function localFiveStart(ms) {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() - (d.getMinutes() % 5));
  return d.getTime();
}

function localDayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localWeekStart(ms) {
  const d = new Date(localDayStart(ms));
  const back = (d.getDay() + 6) % 7; // Monday is the first day of the week.
  d.setDate(d.getDate() - back);
  return d.getTime();
}

function localMonthStart(ms) {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function addHours(ms, hours) {
  const d = new Date(ms);
  d.setHours(d.getHours() + hours);
  return d.getTime();
}

function nextDayStart(ms) {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function blank() {
  return {
    cost: 0,
    tokens: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    rough: false,
  };
}

function addTo(target, record) {
  const input = Number(record.input) || 0;
  const cacheRead = Number(record.cacheRead) || 0;
  const cacheWrite5m = Number(record.cacheWrite5m) || 0;
  const cacheWrite1h = Number(record.cacheWrite1h) || 0;
  const output = Number(record.output) || 0;
  target.cost += Number(record.cost) || 0;
  target.input += input;
  target.cacheRead += cacheRead;
  target.cacheWrite5m += cacheWrite5m;
  target.cacheWrite1h += cacheWrite1h;
  target.output += output;
  target.tokens += input + cacheRead + cacheWrite5m + cacheWrite1h + output;
  if (record.rough) target.rough = true;
}

function cloneTotals(value) {
  const out = blank();
  if (!value || typeof value !== 'object') return out;
  for (const key of Object.keys(out)) {
    if (key === 'rough') out.rough = Boolean(value.rough);
    else out[key] = Number(value[key]) || 0;
  }
  return out;
}

function cloneBucket(value) {
  const out = {};
  for (const provider of PROVIDERS) out[provider] = cloneTotals(value && value[provider]);
  return out;
}

function emptyPer() {
  return { claude: blank(), codex: blank(), omp: blank() };
}

function combine(left, right) {
  for (const provider of PROVIDERS) addTo(left[provider], right[provider]);
  return left;
}

function totalOf(per) {
  const total = blank();
  for (const provider of PROVIDERS) addTo(total, per[provider]);
  return total;
}

function sumBuckets(map, from, to) {
  const per = emptyPer();
  for (const [start, bucket] of map) {
    if (start < from || start >= to) continue;
    combine(per, bucket);
  }
  return per;
}

function dayLabel(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function createLedger({ now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const hours = new Map();
  const fives = new Map();
  const lastAdd = {};

  function add(record) {
    if (!record || typeof record !== 'object') return false;
    const at = Number(record.at);
    if (!Number.isFinite(at)) return false;
    const provider = PROVIDERS.includes(record.provider) ? record.provider : null;
    if (!provider) return false;

    const hour = localHourStart(at);
    let bucket = hours.get(hour);
    if (!bucket) {
      bucket = emptyPer();
      hours.set(hour, bucket);
    }
    addTo(bucket[provider], record);

    const t = clock();
    if (t - at < KEEP_FIVE_MS) {
      const five = localFiveStart(at);
      let small = fives.get(five);
      if (!small) {
        small = emptyPer();
        fives.set(five, small);
      }
      addTo(small[provider], record);
    }
    lastAdd[provider] = { cost: Number(record.cost) || 0, at };
    return true;
  }

  function prune() {
    const t = clock();
    for (const start of hours.keys()) {
      if (t - start > KEEP_HOUR_MS) hours.delete(start);
    }
    for (const start of fives.keys()) {
      if (t - start > KEEP_FIVE_MS) fives.delete(start);
    }
  }

  function hourPeriod(nowMs) {
    const aligned = Math.floor(nowMs / FIVE) * FIVE;
    const from = aligned - 11 * FIVE;
    const bars = [];
    for (let i = 0; i < 12; i++) {
      const start = from + i * FIVE;
      bars.push({ from: start, to: start + FIVE, per: sumBuckets(fives, start, start + FIVE) });
    }
    return { label: 'last 60 min', from, per: sumBuckets(fives, from, aligned + FIVE), bars };
  }

  function todayPeriod(nowMs) {
    const from = localDayStart(nowMs);
    const tomorrow = nextDayStart(from);
    const bars = [];
    for (let i = 0; i < 24; i++) {
      const start = addHours(from, i);
      const end = i === 23 ? tomorrow : addHours(from, i + 1);
      bars.push({ from: start, to: end, per: sumBuckets(hours, start, end) });
    }
    return { label: dayLabel(nowMs), from, per: sumBuckets(hours, from, tomorrow), bars };
  }

  function weekPeriod(nowMs) {
    const from = localWeekStart(nowMs);
    const bars = [];
    for (let i = 0; i < 7; i++) {
      const start = addDays(from, i);
      bars.push({ from: start, to: addDays(from, i + 1), per: sumBuckets(hours, start, addDays(from, i + 1)) });
    }
    return { label: `${dayLabel(from)} → now`, from, per: sumBuckets(hours, from, nowMs + 1), bars };
  }

  function monthPeriod(nowMs) {
    const from = localMonthStart(nowMs);
    const d = new Date(from);
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const bars = [];
    for (let i = 0; i < days; i++) {
      const start = addDays(from, i);
      bars.push({ from: start, to: addDays(from, i + 1), per: sumBuckets(hours, start, addDays(from, i + 1)) });
    }
    const label = MONTHS[d.getMonth()];
    return { label, from, per: sumBuckets(hours, from, nowMs + 1), bars };
  }

  function periods(nowMs) {
    const t = Number.isFinite(Number(nowMs)) ? Number(nowMs) : clock();
    prune();
    const result = {};
    for (const [name, build] of [['hour', hourPeriod], ['today', todayPeriod], ['week', weekPeriod], ['month', monthPeriod]]) {
      const period = build(t);
      period.per.total = totalOf(period.per);
      result[name] = period;
    }
    return result;
  }

  function toJSON() {
    prune();
    return {
      hour: [...hours].map(([start, bucket]) => [start, cloneBucket(bucket)]),
      five: [...fives].map(([start, bucket]) => [start, cloneBucket(bucket)]),
      lastAdd: { ...lastAdd },
    };
  }

  function fromJSON(data) {
    hours.clear();
    fives.clear();
    for (const key of Object.keys(lastAdd)) delete lastAdd[key];
    if (!data || typeof data !== 'object') return;
    for (const [key, map] of [['hour', hours], ['five', fives]]) {
      const list = Array.isArray(data[key]) ? data[key] : [];
      for (const item of list) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const start = Number(item[0]);
        if (!Number.isFinite(start)) continue;
        map.set(start, cloneBucket(item[1]));
      }
    }
    if (data.lastAdd && typeof data.lastAdd === 'object') {
      for (const provider of PROVIDERS) {
        const entry = data.lastAdd[provider];
        if (!entry || typeof entry !== 'object') continue;
        const at = Number(entry.at);
        const cost = Number(entry.cost);
        if (Number.isFinite(at) && Number.isFinite(cost)) lastAdd[provider] = { cost, at };
      }
    }
  }

  return { add, prune, periods, toJSON, fromJSON, get lastAdd() { return lastAdd; } };
}

module.exports = {
  createLedger,
  localHourStart,
  localFiveStart,
  localDayStart,
  localWeekStart,
  localMonthStart,
  PROVIDERS,
};
