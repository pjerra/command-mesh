const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../mesh');

test('server: /state returns state and svg, / returns html, /nope is 404', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-home-'));
  const handle = start({ port: 0, home, timers: false });
  await handle.ready;
  const { server, port, close } = handle;
  try {
    const base = `http://127.0.0.1:${port}`;
    const stateRes = await fetch(base + '/state');
    assert.strictEqual(stateRes.status, 200);
    assert.strictEqual(stateRes.headers.get('cache-control'), 'no-store');
    const body = await stateRes.json();
    assert.ok(body.state && Array.isArray(body.state.entries));
    assert.ok(typeof body.svg === 'string' && body.svg.includes('<svg'));
    const pageRes = await fetch(base + '/');
    assert.strictEqual(pageRes.status, 200);
    const html = await pageRes.text();
    assert.ok(html.includes('Command Mesh'));
    const missing = await fetch(base + '/nope');
    assert.strictEqual(missing.status, 404);
  } finally {
    await close();
    server.unref?.();
  }
});
