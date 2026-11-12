const { test } = require('node:test');
const assert = require('node:assert');
const drawMap = require('../futuristic-renderer');

test('renderer: svg names CLAUDE, CODEX and OMP', () => {
  const board = {
    entries: [
      { id: 'claude-you-1', provider: 'claude', station: 'you', label: 'new message', status: 'ok', startedAt: Date.now(), endedAt: Date.now() },
      { id: 'codex-turn-1', provider: 'codex', station: 'model', label: 'Codex working', status: 'run', startedAt: Date.now() },
      { id: 'omp-tool-1', provider: 'omp', station: 'shell', label: 'Bash git', status: 'run', startedAt: Date.now() },
    ],
    counts: { you: 1, model: 1, shell: 1 },
    models: { claude: 'opus', codex: 'gpt', omp: 'gpt-5' },
    presence: { claude: true, codex: true, omp: true, at: Date.now() },
    usage: { omp: { last: 1.234, session: 5.678, lastAt: Date.now() } },
    sessions: { claude: 2, codex: 1, omp: 3 },
  };
  const svg = drawMap(board, Date.now());
  assert.ok(svg.includes('CLAUDE'), 'names CLAUDE');
  assert.ok(svg.includes('CODEX'), 'names CODEX');
  assert.ok(svg.includes('OMP'), 'names OMP');
  assert.deepStrictEqual(drawMap.providerFor({ id: 'claude-you-1' }), 'claude');
  assert.deepStrictEqual(drawMap.providerFor({ id: 'omp-tool-1' }), 'omp');
});

test('renderer: core name shows session multiplier, no SESSIONS line', () => {
  const board = {
    entries: [],
    counts: {},
    models: { claude: 'opus', codex: 'gpt', omp: 'gpt-5' },
    presence: { claude: true, codex: true, omp: true, at: Date.now() },
    usage: {},
    sessions: { claude: 2, codex: 1, omp: 0 },
  };
  const svg = drawMap(board, Date.now());
  assert.ok(svg.includes('CLAUDE ×2'), 'multi-session core named CLAUDE ×2');
  assert.ok(!svg.includes('SESSIONS'), 'no SESSIONS line');
});

test('renderer: a ticker line stays at least 5 s even when newer calls start, and shows its full text at once', () => {
  const drawMap = require('../futuristic-renderer');
  const key = 'ticker-test-' + Math.random();
  const t0 = 1_700_000_000_000;
  const one = { id: 'a', provider: 'claude', station: 'shell', label: 'Bash git', status: 'run', startedAt: t0 };
  const two = { id: 'b', provider: 'omp', station: 'files', label: 'read src/app.ts', status: 'run', startedAt: t0 + 1000 };
  const first = drawMap({ entries: [one] }, t0 + 100, { tickerKey: key });
  assert.match(first, /CLAUDE :: SHELL :: Bash git/);
  assert.doesNotMatch(first, /<animate attributeName="width"/, 'no typing animation that can leave the line blank');
  const held = drawMap({ entries: [one, two] }, t0 + 3000, { tickerKey: key });
  assert.match(held, /CLAUDE :: SHELL :: Bash git/, 'still the first line inside the hold time');
  const next = drawMap({ entries: [{ ...one, status: 'ok', endedAt: t0 + 2000 }, two] }, t0 + 5200, { tickerKey: key });
  assert.match(next, /OMP :: FILES :: read src\/app.ts/, 'switches after the hold time');
});
