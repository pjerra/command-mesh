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

## Sessions panel

Below USAGE, one row per session active in the last 30 minutes, newest first, at most 20 rows plus a
`+N more` line. Each row shows the project (and `· subagent` for a Claude subagent file), the agent,
the model, the newest event label, how long it has been idle, today's cost for that session and the
number of errors in the last 10 minutes. A session that was working and went quiet for more than
10 minutes with a run still open gets `idle ⚠`; three or more errors in 10 minutes get `errors ⚠`.
Flagged rows sort first. A finished turn that is simply idle is dimmed, not flagged. Sessions idle
for more than two hours are forgotten. Click a row to filter the event feed to that session or
project; click it again to clear. Per-session cost comes from the usage ledger: the collector knows
the log file, Claude names the file after the session id, a subagent file sits under its parent
session folder, and the Codex rollout name ends with its session id. When a provider cannot be
mapped the column shows `--`.

`FAILING · LAST HOUR` sits at the right of the panel (below it on narrow screens): up to five
groups of errors from the last hour, grouped by project and label and sorted by count, for example
`7× bash go test · wt-hakkar-r12`. Only the short labels are kept, never arguments. The board drops
events after 30 minutes, so this list is kept separately for an hour (at most 500 entries).

## Burn and forecast

`Burn` sits next to `Est. cost` and shows the cost of the last 60 minutes from the ledger's
five-minute buckets as `$38/h`, with a per-agent breakdown in the tooltip. The small line under it
projects today's total: today's cost so far plus the burn multiplied by the hours left until local
midnight, always written with `~` because it is a projection. Both figures ignore the selected USAGE
tab: they are always the last hour and today.

Each limit window with usage above 0 percent keeps 30 minutes of samples in memory. When at least
two samples five or more minutes apart give a positive least-squares slope, the strip shows
`· full in 1h 10m` after the countdown, in orange under two hours and red under 30 minutes. Nothing
is shown when the window resets before the forecast would land. The bell button in the LIMITS
header turns browser notifications on or off (off by default, remembered in localStorage). One
notification fires when a window first reaches 80 percent, one at 95 percent and one when it is
exhausted, with the reset time in the body. Each window gets one notification per threshold per
reset period. Demo mode never notifies.

## Privacy

What is stored: station, short label (tool name plus at most the last two path segments or the first word of a shell command), status, timestamps, counts, model name, token and dollar cost totals per agent, and whether each agent process is running. What is never stored: prompt text, tool arguments beyond the short label, tool output, or response text. The Codex live log reads turn ids, tool names, durations, cwd, and model from its SQLite rows; prompt text in that log is never read. The sessions panel and its per-session cost map are in memory only: session ids, project names and the log file path stay in the process and are never written to the cache or served as a path.

## Reading the grid

Colors mean agents. CLAUDE is `#ff9d6b`, CODEX is `#a28aff`, OMP is `#53f4dd`. Cores, station cards, routes, packets, the ticker, the activity bars, and the event feed all use the same colors. A working core pulses. An open but quiet core breathes slowly. A dashed gray core marked OFFLINE means the app is not running. A core name such as `CLAUDE ×2` means two sessions of that agent were active in the last two minutes. Under each core that has cost, a line shows the selected USAGE period: `EST $1.23 · 18.4M tok` for Claude, `EST ~$0.40 · 8.1M tok` for Codex, `COST $0.12 · 31.0M tok` for omp. A new cost also floats up as `+$0.003`. A lit Memory station means Claude loaded memory into a session's starting context, or reloaded it after compaction.

## Tests

```sh
npm test
```

## License

[MIT](LICENSE)
