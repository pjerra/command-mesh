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

test('renderer: a ticker line types slowly, stays readable, then lingers before AWAITING INPUT', () => {
  const drawMap = require('../futuristic-renderer');
  const key = 'ticker-test-' + Math.random();
  const plain = svg => svg.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');
  const t0 = 1_700_000_000_000;
  const one = { id: 'a', provider: 'claude', station: 'shell', label: 'Bash git', status: 'run', startedAt: t0 };
  const two = { id: 'b', provider: 'omp', station: 'files', label: 'read src/app.ts', status: 'run', startedAt: t0 + 1000 };
  const first = drawMap({ entries: [one] }, t0 + 100, { tickerKey: key });
  assert.match(plain(first), /CLAUDE :: SHELL :: Bash git/);
  assert.match(first, /class="tk" style="animation-delay:/, 'characters type in one by one');
  assert.doesNotMatch(first, /<animate attributeName="width"/);
  const held = drawMap({ entries: [one, two] }, t0 + 6000, { tickerKey: key });
  assert.match(plain(held), /CLAUDE :: SHELL :: Bash git/, 'still the first line while it is typed and read');
  const next = drawMap({ entries: [{ ...one, status: 'ok', endedAt: t0 + 2000 }, two] }, t0 + 8000, { tickerKey: key });
  assert.match(plain(next), /OMP :: FILES :: read src\/app.ts/, 'switches after typing + reading time');
  const ended = { ...two, status: 'ok', endedAt: t0 + 9000 };
  assert.match(plain(drawMap({ entries: [ended] }, t0 + 18000, { tickerKey: key })), /OMP :: FILES/, 'a finished line lingers');
  assert.match(plain(drawMap({ entries: [ended] }, t0 + 23000, { tickerKey: key })), /AWAITING INPUT/, 'then clears');
});

test('renderer: each core with cost shows its line; codex shows ~', () => {
  const t = 1_700_000_000_000;
  const board = {
    entries: [],
    counts: {},
    models: { claude: 'opus', codex: 'gpt', omp: 'gpt-5' },
    presence: { claude: true, codex: true, omp: true, at: t },
    usage: {
      claude: { last: 0.001, session: 1.23, lastAt: t },
      codex: { last: 0.002, session: 0.4, lastAt: t, rough: true },
      omp: { last: 0.003, session: 0.12, lastAt: t },
    },
    sessions: { claude: 1, codex: 1, omp: 1 },
  };
  const svg = drawMap(board, t);
  assert.ok(svg.includes('EST $1.23'), 'claude line: EST $1.23');
  assert.ok(svg.includes('EST ~$0.40'), 'codex line: EST ~$0.40');
  assert.ok(svg.includes('COST $0.12'), 'omp line: COST $0.12');
  assert.ok(svg.includes('+$0.003'), 'the newest cost floats up for every core');
});
