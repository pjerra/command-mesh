const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../lib/sound-core');
const { page } = require('../lib/page');

const C = m.musConst();
const inKey = (midi, ci) => C.CHORDS[ci].pcs.includes(midi % 12) || C.PENT.includes(midi % 12);

test('music: progression cycles Am-F-C-G, 2 bars per chord', () => {
  const names = s => C.CHORDS[m.musChordIndex(s)].name;
  assert.strictEqual(names(0), 'Am');
  assert.strictEqual(names(31), 'Am');
  assert.strictEqual(names(32), 'F');
  assert.strictEqual(names(64), 'C');
  assert.strictEqual(names(96), 'G');
  assert.strictEqual(names(128), 'Am');
  assert.strictEqual(names(128 * 50 + 40), 'F');
});

test('music: grid quantization lands on 16th steps at 96 BPM and never in the past', () => {
  const S = 60 / 96 / 4, t0 = 10;
  for (const t of [10, 10.001, 10.08, 10.1563, 13.37, 99.99]) {
    const g = m.musNextGrid(t, t0);
    assert.ok(g >= t - 1e-9);
    assert.ok(g - t < S + 1e-9);
    const k = (g - t0) / S;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6);
  }
  assert.strictEqual(m.musNextStep(10, 10), 0);
  assert.strictEqual(m.musNextStep(10 + S * 2.2, 10), 3);
  assert.strictEqual(m.musNextGrid(5, 10), 10);
});

test('music: every picked note is in the current chord or the pentatonic scale, in register', () => {
  for (const core of ['claude', 'codex', 'omp', 'gemini']) {
    const st = {};
    for (let step = 0; step < 400; step++) {
      if (!m.musAllowed(core, step)) continue;
      const notes = m.musPick(core, st, step), ci = m.musChordIndex(step);
      const [lo, hi] = C.RANGE[core];
      for (const n of notes) { assert.ok(inKey(n, ci), core + ' step ' + step + ' note ' + n); assert.ok(n >= lo && n <= hi); }
      if (core === 'claude') {
        assert.strictEqual(notes.length, 3);
        notes.forEach(n => assert.ok(C.CHORDS[ci].pcs.includes(n % 12)));
      }
      if (core === 'codex') assert.ok([C.CHORDS[ci].root, C.CHORDS[ci].fifth].includes(notes[0] % 12));
    }
  }
});

test('music: instruments follow their rhythm roles', () => {
  assert.ok(m.musAllowed('codex', 0) && !m.musAllowed('codex', 1) && m.musAllowed('codex', 4));
  assert.ok(m.musAllowed('claude', 8) && !m.musAllowed('claude', 6));
  assert.ok(m.musAllowed('gemini', 2) && !m.musAllowed('gemini', 3));
  assert.ok([0, 1, 2, 3].every(s => m.musAllowed('omp', s)));
});

test('music: melodies walk by small steps, not random jumps', () => {
  const st = {}, seq = [];
  for (let s = 0; s < 32; s++) seq.push(m.musPick('omp', st, s)[0]);
  for (let i = 1; i < seq.length; i++) assert.ok(Math.abs(seq[i] - seq[i - 1]) <= 7, seq[i - 1] + '->' + seq[i]);
});

test('music: throttle merges bursts into one louder note, max one per instrument per step', () => {
  const pending = { claude: 1, codex: 6, omp: 2, gemini: 0 }, mem = {};
  const one = m.musStepPlan({ ...pending }, {}, 4);
  const byCore = Object.fromEntries(one.map(p => [p.core, p]));
  assert.strictEqual(one.length, 3);
  assert.ok(byCore.codex.vel > byCore.claude.vel);
  assert.strictEqual(byCore.codex.merged, 6);
  assert.ok(byCore.codex.vel <= 1);
  assert.deepStrictEqual(pending.codex, 6); // copy consumed, not original
  const live = { codex: 6, omp: 2 };
  const a = m.musStepPlan(live, mem, 5); // off-beat: only omp may play
  assert.deepStrictEqual(a.map(p => p.core), ['omp']);
  assert.strictEqual(live.omp, 0); assert.strictEqual(live.codex, 6); // bass waits for its beat
  const b = m.musStepPlan(live, mem, 8);
  assert.deepStrictEqual(b.map(p => p.core), ['codex']);
  assert.strictEqual(live.codex, 0);
  assert.deepStrictEqual(m.musStepPlan(live, mem, 9), []);
  assert.ok(m.musVelocity(1) < m.musVelocity(3));
});

test('music: more agents working = fuller, never over 1', () => {
  assert.ok(m.musFullness(0) < m.musFullness(2));
  assert.ok(m.musFullness(2) < m.musFullness(4) + 1e-9);
  assert.ok(m.musFullness(9) <= 1);
});

test('music: event phrases are in key and start on the grid', () => {
  for (const type of ['done', 'input', 'error', 'alert', 'session']) {
    const ph = m.musPhrase(type, 40);
    assert.ok(ph.length >= 1);
    ph.forEach(n => { assert.ok(n.step >= 40); assert.ok(m.musConst().PENT.includes(n.midi % 12) || [11, 5].includes(n.midi % 12), type + ' ' + n.midi); });
  }
  assert.strictEqual(m.musPhrase('input', 0).length, 2);
  assert.strictEqual(m.musPhrase('alert', 0).length, 3);
  assert.strictEqual(m.musPhraseStart('input', 5), 8);
  assert.strictEqual(m.musPhraseStart('done', 5), 5);
  assert.deepStrictEqual(m.musPhrase('nope', 0), []);
  const d = m.musPhrase('done', 0);
  assert.deepStrictEqual(d.slice(0, 3).map(n => n.midi % 12), [7, 11, 2]); // V
  assert.strictEqual(d[d.length - 1].midi % 12, 0); // resolves to I
});

test('music: page still ships the engine, ambient pad option and controls', () => {
  const html = page();
  for (const s of ['musStepPlan', 'createConvolver', 'createDynamicsCompressor', 'Ambient pad', 'snd-toggle', 'snd-vol', 'command-mesh-sound']) assert.ok(html.includes(s), s);
});
