const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTail } = require('../lib/tail');

test('tail: old content is not replayed, appended lines are delivered, a split line waits for its newline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ a: 1 }) + '\n' + JSON.stringify({ a: 2 }) + '\n');
  const seen = [];
  const tail = startTail({ root: dir, onEvent: (s, e) => seen.push(e), timers: false });
  tail.discover();
  tail.poll();
  assert.strictEqual(seen.length, 0, 'old content is not replayed');
  fs.appendFileSync(file, JSON.stringify({ a: 3 }) + '\n');
  tail.poll();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].a, 3);
  const line = JSON.stringify({ a: 4 });
  fs.appendFileSync(file, line.slice(0, 5));
  tail.poll();
  assert.strictEqual(seen.length, 1, 'split line waits for newline');
  fs.appendFileSync(file, line.slice(5) + '\n');
  tail.poll();
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1].a, 4);
  tail.dispose();
});

test('tail: a file created after the first discover is read from the start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
  const seen = [];
  const tail = startTail({ root: dir, onEvent: (s, e) => seen.push(e), timers: false });
  tail.discover();
  const file = path.join(dir, 'new.jsonl');
  fs.writeFileSync(file, JSON.stringify({ b: 1 }) + '\n' + JSON.stringify({ b: 2 }) + '\n');
  tail.discover();
  tail.poll();
  assert.strictEqual(seen.length, 2);
  assert.deepStrictEqual(seen.map(e => e.b), [1, 2]);
  tail.dispose();
});

test('tail: roots given as a function are all walked, and a root that appears later is picked up', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
  const one = path.join(base, 'one');
  const two = path.join(base, 'two');
  fs.mkdirSync(one);
  fs.writeFileSync(path.join(one, 'a.jsonl'), '');
  const seen = [];
  const roots = () => [one, two].filter(dir => fs.existsSync(dir));
  const tail = startTail({ roots, onEvent: (s, e) => seen.push(e), timers: false });
  tail.discover();
  fs.appendFileSync(path.join(one, 'a.jsonl'), JSON.stringify({ c: 1 }) + '\n');
  fs.mkdirSync(two);
  fs.writeFileSync(path.join(two, 'b.jsonl'), JSON.stringify({ c: 2 }) + '\n');
  tail.discover();
  tail.poll();
  assert.deepStrictEqual(seen.map(e => e.c).sort(), [1, 2]);
  tail.dispose();
});

test('omp: roots cover the default session folder and every profile', () => {
  const omp = require('../lib/sources/omp');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
  fs.mkdirSync(path.join(home, '.omp', 'profiles', 'go2', 'agent', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.omp', 'profiles', 'empty'), { recursive: true });
  assert.deepStrictEqual(omp.roots(home), [
    path.join(home, '.omp', 'agent', 'sessions'),
    path.join(home, '.omp', 'profiles', 'empty', 'agent', 'sessions'),
    path.join(home, '.omp', 'profiles', 'go2', 'agent', 'sessions'),
  ]);
});
