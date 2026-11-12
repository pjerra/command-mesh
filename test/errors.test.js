const { test } = require('node:test');
const assert = require('node:assert');
const { createSessions } = require('../lib/sessions');

test('errors: groups by project+label over 60 min, top 5 by count', () => {
  const t = 1_700_000_000_000;
  const sessions = createSessions({ now: () => t });
  const fail = (project, label, index, ageMs) => ({
    id: `e-${project}-${label}-${index}`, provider: 'claude', station: 'shell', label, status: 'err',
    startedAt: t - ageMs, endedAt: t - ageMs, project,
    detail: { kind: 'Claude tool', session: `sess-${project}-${label}` },
  });

  const counts = [7, 5, 4, 3, 2, 1];
  counts.forEach((count, group) => {
    for (let i = 0; i < count; i++) sessions.note(fail(`proj-${group}`, `bash go ${group}`, i, (i + 1) * 60e3));
  });
  // Older than an hour: never in the spotlight, even with the highest count.
  for (let i = 0; i < 9; i++) sessions.note(fail('proj-old', 'bash go old', i, 70 * 60e3));

  const groups = sessions.errors();
  assert.strictEqual(groups.length, 5, 'top five only');
  assert.deepStrictEqual(groups.map(group => group.count), [7, 5, 4, 3, 2]);
  assert.strictEqual(groups[0].label, 'bash go 0');
  assert.strictEqual(groups[0].project, 'proj-0');
  assert.ok(!groups.some(group => group.project === 'proj-old'), 'a group older than 60 minutes is dropped');
});
