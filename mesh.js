#!/usr/bin/env node
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createBoard } = require('./lib/board');
const { startTail } = require('./lib/tail');
const { startPresence } = require('./lib/presence');
const { page } = require('./lib/page');
const drawMap = require('./futuristic-renderer');
const claude = require('./lib/sources/claude');
const codex = require('./lib/sources/codex');
const omp = require('./lib/sources/omp');

const dashboardCss = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');

function parseArgs(argv) {
  const out = { port: null, home: null, only: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && i + 1 < argv.length) out.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length));
    else if (arg === '--home' && i + 1 < argv.length) out.home = argv[++i];
    else if (arg.startsWith('--home=')) out.home = arg.slice('--home='.length);
    else if (arg === '--only' && i + 1 < argv.length) out.only = argv[++i];
    else if (arg.startsWith('--only=')) out.only = arg.slice('--only='.length);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function start({ port, home, only = '', timers = true } = {}) {
  const resolvedPort = port ?? (process.env.MESH_PORT ? Number(process.env.MESH_PORT) : 4777);
  const resolvedHome = home || os.homedir();
  const board = createBoard({});
  const sources = [claude, codex, omp];
  const tails = sources.map(source => {
    const ctx = { board, now: Date.now, only: only || '' };
    const tail = startTail({
      root: source.root(resolvedHome),
      onEvent: (session, event) => source.handle(ctx, session, event),
      timers,
    });
    return { source, tail, root: source.root(resolvedHome) };
  });
  const presence = timers ? startPresence({ board }) : { dispose() {} };

  const server = http.createServer((request, response) => {
    const urlPath = (request.url || '/').split('?')[0];
    if (urlPath === '/state') {
      const snapshot = board.snapshot();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ state: snapshot, svg: drawMap(snapshot, Date.now()) }));
      return;
    }
    if (urlPath === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page(dashboardCss));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  function countFiles(rootDir) {
    try {
      let n = 0;
      const pending = [rootDir];
      let depth = 0;
      void depth;
      while (pending.length) {
        const dir = pending.pop();
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const item of items) {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) pending.push(full);
          else if (item.isFile() && item.name.endsWith('.jsonl')) n++;
        }
      }
      return n;
    } catch {
      return 0;
    }
  }

  let actualPort = resolvedPort;
  const ready = new Promise((resolve, reject) => {
    server.once('error', err => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`Port ${resolvedPort} is busy. Start with --port <other>`);
        process.exitCode = 1;
        reject(err);
        return;
      }
      reject(err);
    });
    server.listen(resolvedPort, '127.0.0.1', () => {
      const address = server.address();
      actualPort = typeof address === 'object' && address ? address.port : resolvedPort;
      console.log(`Command Mesh: http://127.0.0.1:${actualPort}/`);
      for (const { source, root: sourceRoot } of tails) {
        console.log(`${source.provider}: ${sourceRoot} (${countFiles(sourceRoot)} session files)`);
      }
      resolve();
    });
  });

  function close() {
    return new Promise(resolve => {
      for (const { tail } of tails) {
        try {
          tail.dispose();
        } catch {
          // Ignore dispose errors.
        }
      }
      try {
        presence.dispose();
      } catch {
        // Ignore dispose errors.
      }
      server.close(() => resolve());
    });
  }

  return { server, board, tails, get port() { return actualPort; }, ready, close };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node mesh.js [--port N] [--home DIR] [--only PREFIX]');
    process.exit(0);
  }
  const { close } = start({
    port: args.port ?? (process.env.MESH_PORT ? Number(process.env.MESH_PORT) : 4777),
    home: args.home || os.homedir(),
    only: args.only || '',
  });
  const shutdown = () => {
    close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { start };
