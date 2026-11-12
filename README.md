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
| `--no-limits` | off | Skip the LIMITS strip readers |
| `--no-history` | off | Do not read the logs for usage history; cost and tokens then count only from this start |
| `--cache-file FILE` | `<home>/.cache/command-mesh/usage-v1.json` | Where the usage history cache is read and written |

## Sources

| Source | Folder tailed | Core |
| --- | --- | --- |
| Claude Code sessions | `<home>/.claude/projects` | CLAUDE |
| Codex sessions | `<home>/.codex/sessions` | CODEX |
| Codex live log | `<home>/.codex/logs_<N>.sqlite` (highest N, read-only) | CODEX |
| omp agent sessions | `<home>/.omp/agent/sessions` | OMP |
The board lives in memory in the one `node mesh.js` process. There is no state file.

## Limits

A LIMITS strip sits between the KPIs and the activity bars, one row per account: Claude reads
`<home>/.claude/cache/usage_monthly.json` (refresh 60 s; missing file means the row is hidden), Codex
asks `codex app-server` over JSON-RPC (refresh 180 s; the read itself uses no quota), omp runs
`omp --profile <p> usage -p opencode-go --json` once per profile under `<home>/.omp/profiles`
(refresh 300 s). Nothing about the accounts is stored beyond the window labels, percents, reset
times, plan names, and staleness the strip shows. The Claude row needs a status line that writes
that cache file; without it the row stays hidden. `--no-limits` skips these readers.

## Demo mode

A LIVE | DEMO switch sits in a footer bar under the telemetry panel. DEMO replaces the board with a built-in fake session: three agents on made-up projects, a fake LIMITS strip whose windows slowly fill and wrap, and a DEMO tag next to the title. The live board keeps recording while the demo shows, so LIVE brings back the real activity with nothing lost. The demo reads no data from this machine and is safe for screenshots and recordings. The choice is remembered per browser in localStorage; there is no command line flag.

## Usage history

Cost and tokens are kept in a persistent ledger, not in memory only. Each agent's usage is bucketed
by local time and shown in the USAGE panel with Hour (last 60 minutes), Today (since local
midnight), Week (since Monday 00:00) and Month (since the 1st). The `Est. cost` and `Tokens` KPIs,
the table and the stacked cost chart all follow the selected tab; the tab is remembered in
localStorage. Under each core the same period's line appears: `EST $1.23 · 18.4M tok` (Claude),
`EST ~$0.40 · 8.1M tok` (Codex), `COST $0.12 · 31.0M tok` (omp).

The cache file is `<home>/.cache/command-mesh/usage-v1.json` (override with `--cache-file`). On the
first start it back-fills the current week and month from the session logs, which can take a minute
on a machine with several gigabytes of logs; later starts read the cache and only pick up new
lines. Delete the cache file to rebuild it from the logs. `--no-history` skips the log read and the
cache entirely, so cost and tokens count only from the moment the process started.

| Agent | Source | How exact |
| --- | --- | --- |
| Claude | `message.usage` on assistant lines | Exact: input, output, cache read, 5m cache write and 1h cache write are priced separately. One reply spans several lines with the same usage, so it is counted once by message id. |
| Codex | rollout `token_count` events, or the live log | Rollout costs use the reported tokens and are exact for those tokens. The live log has no token counts, so each model call is estimated from the growth of `total_usage_tokens`; that is what the `~` marks. |
| omp | `message.usage.cost.total` | Exact: the CLI reports its own dollar cost. |

When both Codex readers see the same turn, only the rollout counts. Prices are USD per 1M tokens
in `lib/prices.js`; edit that file when they change. Claude entries match the longest model id
prefix, and an unknown model adds no cost but its tokens still count. The Codex table has one
`codex-default` entry holding GPT-5 list prices, used whatever model Codex runs. A cache write
without a 5m/1h split is priced as five minutes. The cache file holds only counts and the dedupe
ids (message ids and Codex turn ids); no log text is written to it.

## Privacy

What is stored: station, short label (tool name plus at most the last two path segments or the first word of a shell command), status, timestamps, counts, model name, token and dollar cost totals per agent, and whether each agent process is running. What is never stored: prompt text, tool arguments beyond the short label, tool output, or response text. The Codex live log reads turn ids, tool names, durations, cwd, and model from its SQLite rows; prompt text in that log is never read.

## Reading the grid

Colors mean agents. CLAUDE is `#ff9d6b`, CODEX is `#a28aff`, OMP is `#53f4dd`. Cores, station cards, routes, packets, the ticker, the activity bars, and the event feed all use the same colors. A working core pulses. An open but quiet core breathes slowly. A dashed gray core marked OFFLINE means the app is not running. A core name such as `CLAUDE ×2` means two sessions of that agent were active in the last two minutes. Under each core that has cost, a line shows the selected USAGE period: `EST $1.23 · 18.4M tok` for Claude, `EST ~$0.40 · 8.1M tok` for Codex, `COST $0.12 · 31.0M tok` for omp. A new cost also floats up as `+$0.003`. A lit Memory station means Claude loaded memory into a session's starting context, or reloaded it after compaction.

## Tests

```sh
npm test
```

## License

[MIT](LICENSE)
