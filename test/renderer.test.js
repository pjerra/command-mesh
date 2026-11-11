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
