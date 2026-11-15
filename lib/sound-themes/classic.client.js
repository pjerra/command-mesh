// Sound theme "Classic": the first version's synthesized blips, arpeggio, ding-dong, bwomp, chime and whoosh,
// one voice per core (claude warm, codex crisp, omp bubbly, gemini sparkly). Voices and notes are exactly as
// they were in the original commit; only the plumbing (own output chain, start/stop) is new.
let clsIn = null;
// One synthesized note: type, start freq, optional glide target, start offset, length, peak gain.
function clsTone(f0, t0, len, type, peak, f1) {
  const c = sndCtx, t = c.currentTime + t0, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.8);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g); g.connect(clsIn); o.start(t); o.stop(t + len + 0.03);
}
const CLS_VOICE = {
  claude: (f, t, l, p) => { clsTone(f * 0.5, t, l * 1.3, 'sine', p); clsTone(f, t, l, 'triangle', p * 0.6); },
  codex: (f, t, l, p) => { clsTone(f * 1.5, t, l * 0.6, 'square', p * 0.35); clsTone(f * 3, t, l * 0.3, 'triangle', p * 0.25); },
  omp: (f, t, l, p) => { clsTone(f * 0.8, t, l, 'sine', p, f * 1.7); },
  gemini: (f, t, l, p) => { clsTone(f * 2, t, l, 'sine', p * 0.6); clsTone(f * 3.01, t + 0.035, l * 0.8, 'sine', p * 0.4); }
};
const CLS_BASE = { claude: 330, codex: 440, omp: 392, gemini: 523 };
const CLS_SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
sndRegister({
  id: 'classic', name: 'Classic', order: 0,
  start() {
    if (!sndCtx || !sndOut) return;
    clsIn = sndCtx.createGain();
    const comp = sndCtx.createDynamicsCompressor();
    clsIn.connect(comp); comp.connect(sndOut);
  },
  stop() { clsIn = null; },
  onActivity(core, vel) { if (clsIn) { CLS_VOICE[core](CLS_BASE[core] * 1.5, 0, 0.09, 0.22 * Math.min(1, vel || 1)); sndPulse(core); } },
  onDone(core) { if (clsIn) { [0, 2, 3, 5].forEach((s, i) => CLS_VOICE[core](CLS_BASE[core] * CLS_SCALE[s], i * 0.085, 0.22, 0.3)); sndPulse(core); } },
  onNeedsInput(core) { if (clsIn) { clsTone(784, 0, 0.5, 'sine', 0.28); clsTone(784 * 0.75, 0.28, 0.7, 'sine', 0.26); sndPulse(core); } },
  onError(core) { if (clsIn) { clsTone(150, 0, 0.42, 'sine', 0.4, 70); sndPulse(core); } },
  onAlert(core) { if (clsIn) { [880, 1175, 1568].forEach((f, i) => clsTone(f, i * 0.11, 0.35, 'triangle', 0.2)); sndPulse(core || 'claude'); } },
  onNewSession(core) {
    if (!clsIn) return;
    clsTone(260, 0, 0.45, 'sawtooth', 0.05, 1900);
    [1568, 2093, 2637].forEach((f, i) => clsTone(f, 0.12 + i * 0.07, 0.22, 'sine', 0.12));
    sndPulse(core);
  }
});
