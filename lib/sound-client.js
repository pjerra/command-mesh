'use strict';

// Builds the browser sound script: pure logic (sound-core) + the shell (sound-ui.client.js) + every theme
// in lib/sound-themes/*.client.js (one file per theme, found automatically) + the final bind.
const fs = require('fs');
const path = require('path');
const core = require('./sound-core');

const read = f => fs.readFileSync(f, 'utf8');
const dir = path.join(__dirname, 'sound-themes');
const themeFiles = fs.readdirSync(dir).filter(f => f.endsWith('.client.js')).sort();
const source = [core.source, read(path.join(__dirname, 'sound-ui.client.js'))]
  .concat(themeFiles.map(f => read(path.join(dir, f))), ['sndBind();']).join('\n');

module.exports = { source, themeFiles };
