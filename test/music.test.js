const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const m = require('../lib/sound-core');
const { page } = require('../lib/page');

const C = m.musConst();
const CORES = ['claude', 'codex', 'omp', 'gemini'];
const setOf = ci => C.CHORDS[ci].set;
const barEnd = (step, t0) => m.musStepTime((Math.floor(step / 8) + 1) * 8, t0);

test('jazz: default 92 BPM, Dm9 - G13 - Cmaj9 - A7b9, one chord per bar', () => {
  assert.strictEqual(C.BPM, 92);
  assert.strictEqual(m.musConst(120).BPM, 120);
  assert.strictEqual(m.musClampBpm(10), 70);
  assert.strictEqual(m.musClampBpm(500), 120);
  assert.strictEqual(m.musClampBpm('abc'), 92);
  const names = s => C.CHORDS[m.musChordIndex(s)].name;
  assert.deepStrictEqual([0, 7, 8, 15, 16, 24, 31, 32].map(names), ['Dm9', 'Dm9', 'G13', 'G13', 'Cmaj9', 'A7b9', 'A7b9', 'Dm9']);
  assert.strictEqual(names(32 * 50 + 9), 'G13');
});

test('swing: beats are 92 BPM apart, off-8ths land 2:1, next-step maths agrees', () => {
  const t0 = 10, B = 60 / 92;
  assert.ok(Math.abs(m.musStepTime(2, t0) - (t0 + B)) < 1e-9);
  for (let s = 0; s < 40; s += 2) {
    const on = m.musStepTime(s, t0), off = m.musStepTime(s + 1, t0), nxt = m.musStepTime(s + 2, t0);
    assert.ok(Math.abs((off - on) / (nxt - off) - 2) < 1e-9, 'long:short must be 2:1 at step ' + s);
  }
  for (const t of [10, 10.001, 10.4, 10.56, 10.57, 13.37, 99.99]) {
    const n = m.musNextStep(t, t0), g = m.musStepTime(n, t0);
    assert.ok(g >= t - 1e-9, 'never in the past');
    if (n > 0) assert.ok(m.musStepTime(n - 1, t0) < t, 'and it is the first such step');
    assert.strictEqual(m.musNextGrid(t, t0), g);
  }
  assert.strictEqual(m.musNextStep(5, 10), 0);
});

test('harmony: every chord set contains its chord tones; no global scale exists', () => {
  assert.strictEqual(m.musConst().PENT, undefined);
  C.CHORDS.forEach(ch => ch.tones.concat(ch.comp, [ch.root]).forEach(pc => assert.ok(ch.set.includes(pc), ch.name)));
});

test('activity notes: always in the CURRENT chord set and inside the instrument register', () => {
  for (const core of CORES) {
    const st = {};
    for (let step = 0; step < 600; step++) {
      if (!m.musAllowed(core, step)) continue;
      const notes = m.musPick(core, st, step), ci = m.musChordIndex(step), [lo, hi] = C.RANGE[core];
      notes.forEach(n => { assert.ok(setOf(ci).includes(n % 12), core + ' step ' + step + ' note ' + n + ' over ' + C.CHORDS[ci].name); assert.ok(n >= lo && n <= hi); });
      if (core === 'claude') assert.deepStrictEqual(notes.map(n => n % 12).sort(), C.CHORDS[ci].comp.slice().sort());
      if (core === 'codex' && step % 8 === 0) assert.strictEqual(notes[0] % 12, C.CHORDS[ci].root);
      if (core === 'codex' || core === 'gemini') assert.ok(C.CHORDS[ci].tones.includes(notes[0] % 12));
    }
  }
});

test('registers: instrument ranges never overlap and respect the brief', () => {
  const r = C.RANGE, order = ['codex', 'claude', 'omp', 'gemini'];
  for (let i = 1; i < order.length; i++) assert.ok(r[order[i - 1]][1] < r[order[i]][0], order[i - 1] + ' vs ' + order[i]);
  assert.ok(r.codex[0] >= 28 && r.codex[1] <= 48 && r.claude[0] >= 48 && r.claude[1] <= 72 && r.omp[0] >= 60 && r.omp[1] <= 84 && r.gemini[0] >= 72 && r.gemini[1] <= 91);
});

test('Rhodes voicings: rootless 3-7-9, smooth voice-leading, no semitone clusters', () => {
  let prev;
  for (let i = 0; i < 16; i++) {
    const ci = i % 4, v = m.musVoicing(ci, prev);
    assert.strictEqual(v.length, 3);
    assert.ok(v.every(n => n >= C.RANGE.claude[0] && n <= C.RANGE.claude[1]));
    assert.ok(v[1] - v[0] >= 2 && v[2] - v[1] >= 2);
    assert.ok(!v.some(n => n % 12 === C.CHORDS[ci].root), 'rootless');
    if (prev) assert.ok(v.reduce((a, n, k) => a + Math.abs(n - prev[k]), 0) <= 12, 'close to the last voicing: ' + prev + ' -> ' + v);
    prev = v;
  }
});

test('walking bass and lead walk by small steps', () => {
  const b = {}, bass = [];
  for (let s = 0; s < 64; s += 2) bass.push(m.musPick('codex', b, s)[0]);
  for (let i = 1; i < bass.length; i++) assert.ok(Math.abs(bass[i] - bass[i - 1]) <= 12, bass[i - 1] + '->' + bass[i]);
  const g = {}, lead = [];
  for (let s = 0; s < 64; s += 2) lead.push(m.musPick('gemini', g, s)[0]);
  for (let i = 1; i < lead.length; i++) assert.ok(Math.abs(lead[i] - lead[i - 1]) <= 9, lead[i - 1] + '->' + lead[i]);
});

test('notes are cut before the next bar line', () => {
  const t0 = 3;
  for (let step = 0; step < 64; step++) for (const want of [0.1, 0.8, 1.6, 5, 30]) {
    const len = m.musNoteLen(step, t0, want);
    assert.ok(len <= want + 1e-9 || len === 0.05);
    assert.ok(m.musStepTime(step, t0) + len <= barEnd(step, t0) - C.RELEASE + 1e-9, 'step ' + step + ' want ' + want);
  }
});

test('density: max 1 note per instrument and max 3 new notes per step, extras wait', () => {
  const pending = { claude: 4, codex: 4, omp: 4, gemini: 4 }, mem = {};
  const one = m.musStepPlan({ ...pending }, {}, 0, [], { drums: true });
  assert.strictEqual(one.length, 3);
  assert.deepStrictEqual(one.map(p => p.core), ['codex', 'gemini', 'omp']);
  const live = { ...pending };
  m.musStepPlan(live, mem, 0, []);
  assert.strictEqual(live.claude, 4, 'the one that did not fit keeps waiting (becomes velocity)');
  const again = m.musStepPlan(live, mem, 3, []);
  assert.deepStrictEqual(again.map(p => p.core), ['claude']);
  assert.ok(m.musVelocity(1) < m.musVelocity(3));
  // a long random run never breaks the cap, and merging keeps velocity <= 1
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const P = { claude: 0, codex: 0, omp: 0, gemini: 0 }, M = {}, phrases = [];
  for (let step = 0; step < 2000; step++) {
    CORES.forEach(c => { if (rnd() < 0.7) P[c]++; });
    if (rnd() < 0.2) m.musPhrase(['done', 'input', 'error', 'alert', 'session'][Math.floor(rnd() * 5)], step + (step % 2)).forEach(n => phrases.push(n));
    const plan = m.musStepPlan(P, M, step, phrases, { drums: true });
    const insts = plan.map(p => p.core);
    assert.ok(plan.length <= 3, 'step ' + step + ' has ' + plan.length);
    assert.strictEqual(new Set(insts).size, insts.length);
    plan.forEach(p => assert.ok(p.vel <= 1));
  }
});

test('drums: brushes on 2 and 4, ride pings, nothing on the lowest-priority slot over the cap', () => {
  const hits = Array.from({ length: 8 }, (_, s) => m.musDrumHit(s));
  assert.ok(hits[2].brush && hits[6].brush && !hits[0].brush && !hits[4].brush);
  assert.ok(hits[0].ride && hits[3].ride && !hits[1]);
  assert.deepStrictEqual(m.musStepPlan({}, {}, 2, [], { drums: false }), []);
  assert.strictEqual(m.musStepPlan({}, {}, 2, [], { drums: true })[0].core, 'drums');
});

test('event motifs: on a beat, jazz roles, pitches picked from the chord at the moment they sound', () => {
  assert.strictEqual(m.musPhraseStart('input', 5), 6);
  assert.strictEqual(m.musPhraseStart('done', 6), 6);
  assert.deepStrictEqual(m.musPhrase('nope', 0), []);
  const insts = t => new Set(m.musPhrase(t, 0).map(n => n.inst));
  assert.deepStrictEqual([...insts('done')], ['omp']);
  assert.deepStrictEqual([...insts('input')], ['gemini']);
  assert.deepStrictEqual([...insts('error')], ['codex']);
  assert.deepStrictEqual([...insts('alert')], ['omp']);
  assert.deepStrictEqual([...insts('session')], ['claude']);
  assert.strictEqual(m.musPhrase('input', 0).length, 2);
  assert.strictEqual(m.musPhrase('alert', 0).length, 3);
  // Play every motif starting at every step of the 4-bar loop, including motifs that cross a bar line.
  for (const type of ['done', 'input', 'error', 'alert', 'session']) for (let start = 0; start < 64; start += 2) {
    const phrases = m.musPhrase(type, start), mem = {};
    for (let step = start; step < start + 40 && phrases.length; step++) {
      m.musStepPlan({}, mem, step, phrases).forEach(p => {
        const ci = m.musChordIndex(step), [lo, hi] = C.RANGE[p.core];
        p.notes.forEach(n => { assert.ok(setOf(ci).includes(n % 12), type + '@' + start + ' step ' + step + ' note ' + n + ' over ' + C.CHORDS[ci].name); assert.ok(n >= lo && n <= hi); });
        if (type === 'error') assert.strictEqual(p.notes[0] % 12, C.CHORDS[ci].root);
      });
    }
    assert.strictEqual(phrases.length, 0, type + ' fully played');
  }
  // trumpet question: the 5th, then up (to the 6th where the chord has it)
  const q = m.musPhrase('input', 16), qm = {};
  const got = [];
  for (let s = 16; s < 22; s++) m.musStepPlan({}, qm, s, q).forEach(p => got.push(p.notes[0]));
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0] % 12, 7, 'Cmaj9: 5th is G');
  assert.strictEqual(got[1] % 12, 9, 'Cmaj9: 6th is A');
  assert.ok(got[1] > got[0]);
});

// ---- Run the real browser script against a fake Web Audio and check what it actually schedules. ----
function rig(stored) {
  const oscs = [], notes = [];
  const param = () => ({ value: 0, setTargetAtTime() {}, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() {}, gain: param(), frequency: param(), detune: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  class AC {
    constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
    createGain() { return node(); }
    createDynamicsCompressor() { return node(); }
    createConvolver() { return node(); }
    createBiquadFilter() { return node(); }
    createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
    createBufferSource() { const n = node(); n.start = t => { n.t = t; }; n.stop = t => oscs.push({ start: n.t, stop: t }); return n; }
    createOscillator() { const n = node(); n.start = t => { n.t = t; }; n.stop = t => oscs.push({ start: n.t, stop: t }); return n; }
    resume() {}
  }
  const ctx = {
    console, Math, Number, String, JSON, Array, Object, Float32Array, Date, setInterval: () => 0, setTimeout: () => 0,
    AudioContext: AC, __trace: n => notes.push(n),
    localStorage: { getItem: () => (stored ? JSON.stringify(stored) : null), setItem() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(require('../lib/sound-client').source, ctx);
  vm.runInContext('sndTrace = __trace; sndEnsure();', ctx);
  assert.strictEqual(vm.runInContext('sndActive && sndActive.id', ctx), (stored && stored.theme) || 'classic');
  return { ctx, oscs, notes, run: code => vm.runInContext(code, ctx) };
}

for (const bpm of [92, 120]) test('page script at ' + bpm + ' BPM: every scheduled note (activity + events) is in the current chord, in register, cut at the bar line', () => {
  const r = rig({ theme: 'jazz', tempo: bpm });
  const BE = 60 / bpm;
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  r.run('sndWorking = 3');
  const types = ['done', 'input', 'error', 'alert', 'session'];
  for (let i = 0; i < 1200; i++) { // 1200 * 0.1s = 120 s of simulated playing
    r.run('sndCtx.currentTime = ' + (i * 0.1));
    if (rnd() < 0.6) r.run('sndPending.' + CORES[Math.floor(rnd() * 4)] + ' = (sndPending.' + CORES[0] + ' || 0) + 1');
    if (rnd() < 0.08) r.run('sndQueuePhrase({type:' + JSON.stringify(types[Math.floor(rnd() * 5)]) + ', core:' + JSON.stringify(CORES[Math.floor(rnd() * 4)]) + '})');
    r.run('sndSchedule()');
  }
  const t0 = r.run('sndT0');
  assert.strictEqual(r.run('sndBpm'), bpm);
  assert.ok(r.notes.length > 200, 'played a lot: ' + r.notes.length);
  assert.ok(r.notes.some(n => n.event) && CORES.every(c => r.notes.some(n => n.inst === c)));
  const perStep = {};
  r.notes.forEach(n => {
    const ci = m.musChordIndex(n.step), [lo, hi] = C.RANGE[n.inst];
    assert.strictEqual(n.bpm, bpm);
    assert.ok(setOf(ci).includes(n.midi % 12), n.inst + ' step ' + n.step + ' note ' + n.midi + ' over ' + C.CHORDS[ci].name + (n.event ? ' (event)' : ''));
    assert.ok(n.midi >= lo && n.midi <= hi, n.inst + ' ' + n.midi + ' out of register');
    assert.ok(Math.abs(n.when - m.musStepTime(n.step, t0, bpm)) < 1e-9, 'swung grid time');
    assert.ok(n.when + n.len <= m.musStepTime((Math.floor(n.step / 8) + 1) * 8, t0, bpm) - C.RELEASE + 1e-9, 'rings past the bar line');
    (perStep[n.step] = perStep[n.step] || {})[n.inst] = (perStep[n.step][n.inst] || 0) + (n.inst === 'claude' ? 0 : 1);
  });
  // voices (oscillators) never outlive the bar they start in
  r.oscs.forEach(o => {
    const k = Math.floor((o.start - t0 + 1e-6) / (4 * BE)), end = t0 + (k + 1) * 4 * BE;
    assert.ok(o.stop <= end + 1e-6, 'oscillator stops ' + (o.stop - end) + 's after the bar line');
  });
  const byStep = {};
  r.notes.forEach(n => { (byStep[n.step] = byStep[n.step] || new Set()).add(n.inst); });
  Object.values(byStep).forEach(s => assert.ok(s.size <= 3));
  Object.values(perStep).forEach(o => Object.entries(o).forEach(([k, v]) => assert.ok(v <= 1, k + ' played twice in one step')));
});

test('tempo: re-anchoring keeps the bar line where it was and the swing at 2:1', () => {
  const t0 = 5, old = 92, nu = 120;
  for (const bar of [1, 2, 7, 40]) {
    const step = bar * 8, t1 = m.musRetempo(step, t0, old, nu);
    assert.ok(Math.abs(m.musStepTime(step, t1, nu) - m.musStepTime(step, t0, old)) < 1e-9, 'same time at the tempo change');
    for (let s = step; s < step + 16; s += 2) {
      const on = m.musStepTime(s, t1, nu), off = m.musStepTime(s + 1, t1, nu), nxt = m.musStepTime(s + 2, t1, nu);
      assert.ok(Math.abs((off - on) / (nxt - off) - 2) < 1e-9);
      assert.ok(Math.abs(nxt - on - 60 / nu) < 1e-9);
    }
    // cuts and chord indices still line up after the change
    for (let s = step; s < step + 16; s++) assert.ok(m.musStepTime(s, t1, nu) + m.musNoteLen(s, t1, 30, nu) <= m.musStepTime((Math.floor(s / 8) + 1) * 8, t1, nu) - C.RELEASE + 1e-9);
  }
});

test('page script: a tempo change waits for the next bar line, then grid and cuts follow the new tempo', () => {
  const r = rig({ theme: 'jazz', tempo: 92 });
  r.run('sndWorking = 3');
  const play = (from, to) => { for (let i = from; i < to; i++) { r.run('sndCtx.currentTime = ' + (i * 0.05) + '; sndPending.codex = 1; sndPending.omp = 1; sndSchedule()'); } };
  play(0, 130);
  const at = r.notes.length, t0a = r.run('sndT0');
  r.run('sndSetTempo(120)');
  assert.strictEqual(r.run('snd.tempo'), 120);
  assert.strictEqual(r.run('sndBpm'), 92, 'not applied mid-bar');
  play(130, 600);
  assert.strictEqual(r.run('sndBpm'), 120);
  const after = r.notes.slice(at), t0b = r.run('sndT0');
  assert.notStrictEqual(t0a, t0b);
  const switched = after.find(n => n.bpm === 120);
  assert.ok(switched && switched.step % 8 === 0, 'first note at the new tempo starts a bar: step ' + (switched && switched.step));
  r.notes.forEach(n => {
    assert.ok(Math.abs(n.when - m.musStepTime(n.step, n.t0, n.bpm)) < 1e-9);
    assert.ok(n.when + n.len <= m.musStepTime((Math.floor(n.step / 8) + 1) * 8, n.t0, n.bpm) - C.RELEASE + 1e-9, 'cut before the bar line, step ' + n.step + ' at ' + n.bpm);
    assert.ok(m.musChordIndex(n.step) >= 0 && C.CHORDS[m.musChordIndex(n.step)].set.includes(n.midi % 12));
  });
  // the bar line at the change is continuous: last old-tempo bar end == first new-tempo bar start
  const last = r.notes.filter(n => n.bpm === 92).pop(), first = switched;
  assert.ok(Math.abs(m.musStepTime(first.step, first.t0, 120) - m.musStepTime(first.step, last.t0, 92)) < 1e-9);
  // out-of-range input is clamped
  r.run('sndSetTempo(5)'); assert.strictEqual(r.run('snd.tempo'), 70);
  r.run('sndSetTempo(999)'); assert.strictEqual(r.run('snd.tempo'), 120);
});

test('page script: drums only play while working and when the box is on', () => {
  const r = rig({ theme: 'jazz' });
  const hits = () => r.oscs.length;
  for (let i = 0; i < 400; i++) { r.run('sndCtx.currentTime = ' + i * 0.1 + '; sndSchedule()'); }
  assert.strictEqual(hits(), 0, 'silent when idle');
  r.run('sndWorking = 1');
  for (let i = 400; i < 600; i++) { r.run('sndCtx.currentTime = ' + i * 0.1 + '; sndSchedule()'); }
  assert.ok(hits() > 20, 'ride and brushes while working');
  const n = hits();
  r.run('snd.enabled.drums = false');
  for (let i = 600; i < 800; i++) { r.run('sndCtx.currentTime = ' + i * 0.1 + '; sndSchedule()'); }
  assert.strictEqual(hits(), n, 'drums checkbox off = no drums');
});

test('page: ships both themes and all controls (volume, mute, menu, drums box)', () => {
  const html = page();
  for (const s of ['musStepPlan', 'createConvolver', 'createDynamicsCompressor', 'createBiquadFilter', 'Drums (brushes + ride)', 'snd-toggle', 'snd-vol', 'snd-pct', 'command-mesh-sound']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('Ambient pad'));
});
