const { test } = require('node:test');
const assert = require('node:assert');
const { classify, shortLabel } = require('../lib/classify');

test('classify: table', () => {
  const cases = [
    ['Bash', { command: 'git status' }, 'shell'],
    ['bash', {}, 'shell'],
    ['exec', {}, 'shell'],
    ['Read', { file_path: '/x/y.txt' }, 'files'],
    ['Edit', {}, 'files'],
    ['Grep', {}, 'files'],
    ['Read', { file_path: '/home/user/.claude/projects/d/memory/store.md' }, 'memory'],
    ['remember_context', {}, 'memory'],
    ['Agent', { subagent_type: 'Explore' }, 'agents'],
    ['Task', {}, 'agents'],
    ['Skill', { skill: 'commit' }, 'skills'],
    ['Read', { file_path: '/repo/skills/deploy/SKILL.md' }, 'skills'],
    ['WebFetch', { url: 'https://example.com' }, 'web'],
    ['mcp__playwright__click', {}, 'browser'],
    ['todo', {}, 'model'],
    ['wait', {}, 'agents'],
    ['frobnicate', {}, 'model'],
  ];
  for (const [tool, input, want] of cases) {
    assert.strictEqual(classify(tool, input), want, `${tool} -> ${want}`);
  }
});

test('classify: shortLabel cases', () => {
  assert.strictEqual(shortLabel('Bash', { command: 'git status' }), 'Bash git');
  assert.strictEqual(shortLabel('Bash', { command: '/usr/bin/docker ps -a' }), 'Bash docker');
  assert.strictEqual(shortLabel('Read', { file_path: '/a/b/c/d.js' }), 'Read c/d.js');
  assert.strictEqual(shortLabel('Edit', { file_path: '/a/b.js:10-20' }), 'Edit a/b.js');
  assert.strictEqual(shortLabel('mcp__hub__progress', {}), 'hub:progress');
  assert.strictEqual(shortLabel('Skill', { skill: 'commit' }), 'Skill commit');
  assert.strictEqual(shortLabel('Task', { subagent_type: 'Explore' }), 'Task Explore');
  assert.strictEqual(shortLabel('frobnicate', {}), 'frobnicate');
});

test('classify: shell labels strip assignments, cd chains, and wrappers', () => {
  assert.strictEqual(shortLabel('Bash', { command: 'S=/tmp/x; curl a' }), 'Bash curl');
  assert.strictEqual(shortLabel('Bash', { command: 'API_KEY=sk-secret curl x' }), 'Bash curl');
  assert.strictEqual(shortLabel('Bash', { command: 'cd /a/b && git status' }), 'Bash git');
  assert.strictEqual(shortLabel('Bash', { command: '"$HOME/bin/x" y' }), 'Bash');
  assert.strictEqual(shortLabel('Bash', { command: 'sudo docker ps' }), 'Bash docker');
});

test('classify: an assignment holding a command substitution never leaks its inner words', () => {
  assert.strictEqual(shortLabel('Bash', { command: 'f=$(ls -t /a | head -1); grep -c x "$f"' }), 'Bash grep');
  assert.strictEqual(shortLabel('Bash', { command: 'X=$(echo sk-secret-123 | tr a b) curl x' }), 'Bash curl');
  assert.strictEqual(shortLabel('Bash', { command: 'X=`echo sk-secret-123` curl x' }), 'Bash curl');
  assert.strictEqual(shortLabel('Bash', { command: 'X="a b"$(echo $(date)) curl x' }), 'Bash curl');
  assert.strictEqual(shortLabel('Bash', { command: 'X=$(echo sk-secret-123 curl x' }), 'Bash');
  assert.strictEqual(shortLabel('Bash', { command: 'X="sk-secret-123 curl x' }), 'Bash');
});
