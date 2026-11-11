# Command Mesh

Command Mesh is a standalone local web dashboard that shows coding agent activity as an animated operations grid. One command starts it:

```sh
node mesh.js
```

It prints `Command Mesh: http://127.0.0.1:4777/` and the browser shows three cores, CLAUDE, CODEX, and OMP, fed by tailing the session logs of every session on the machine.

## Attribution

Command Mesh is based on the original [Lot Map](https://github.com/alexeyw/lot-map) created by [Aleksei Volodin](https://github.com/alexeyw) and used under the MIT License. The VS Code, Codex, Copilot, and Kiro integrations and additional modifications are by [Deemer15](https://github.com/Deemer15). This fork is the standalone Claude/Codex/omp version.

## Requirements

Node 20 or later. Linux, WSL, or macOS. The Codex live log needs Node 22.5+ for its `node:sqlite` read; the rest works on 20.

## Run

```sh
node mesh.js
node mesh.js --port 4788
node mesh.js --only /home/user/demo
MESH_PORT=4788 node mesh.js
```

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `--port N` (or `MESH_PORT`) | 4777 | Local port to listen on, `127.0.0.1` only |
| `--home DIR` | your home folder | Where the three session folders below are looked up |
| `--only PREFIX` | empty | Only record sessions whose working directory starts with PREFIX |
| `--help` | | Print usage and exit |

## Sources

| Source | Folder tailed | Core |
| --- | --- | --- |
| Claude Code sessions | `<home>/.claude/projects` | CLAUDE |
| Codex sessions | `<home>/.codex/sessions` | CODEX |
| Codex live log | `<home>/.codex/logs_<N>.sqlite` (highest N, read-only) | CODEX |
| omp agent sessions | `<home>/.omp/agent/sessions` | OMP |
The board lives in memory in the one `node mesh.js` process. There is no state file.

## Privacy

What is stored: station, short label (tool name plus at most the last two path segments or the first word of a shell command), status, timestamps, counts, model name, session cost for omp, and whether each agent process is running. What is never stored: prompt text, tool arguments beyond the short label, tool output, or response text. The Codex live log reads turn ids, tool names, durations, cwd, and model from its SQLite rows; prompt text in that log is never read.

## Reading the grid

Colors mean agents. CLAUDE is `#ff9d6b`, CODEX is `#a28aff`, OMP is `#53f4dd`. Cores, station cards, routes, packets, the ticker, the activity bars, and the event feed all use the same colors. A working core pulses. An open but quiet core breathes slowly. A dashed gray core marked OFFLINE means the app is not running. A core name such as `CLAUDE ×2` means two sessions of that agent were active in the last two minutes. Under OMP the grid shows the cost in dollars since the dashboard started.

## Tests

```sh
npm test
```

## License

[MIT](LICENSE)
