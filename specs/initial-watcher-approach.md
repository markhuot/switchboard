# Watcher Specification

Status: Draft

## Overview

A **watcher** is the abstraction that connects Switchboard to an external task source (Jira, Linear, GitHub Issues, etc.). The orchestrator polls the watcher on a fixed cadence to get a fresh list of tasks. Watchers are pluggable -- Switchboard ships a few built-in watchers but any user can provide their own.

A watcher's only job is fetching. It returns "here are N tasks for you to work on." Switchboard handles everything else -- locking, dispatch, deadlettering, and retries.

## CLI Interface

### `--watch` (required)

Determines which watcher to use. Supports three modes:

```
# 1. Built-in watcher by name
switchboard --watch=jira

# 2. Local TypeScript module conforming to the Watcher interface
switchboard --watch=./adapters/my-jira.ts

# 3. Shell command (prefixed with $)
switchboard --watch="$ gh issue list --label=Backlog --json number,title,body"
```

### `--poll-interval` (optional)

How often to call the watcher. Accepts a human-readable duration string.

```
switchboard --watch=jira --poll-interval=3s
switchboard --watch=jira --poll-interval=30s
switchboard --watch=jira --poll-interval=2m
```

Default: `30s`

Supported suffixes: `s` (seconds), `m` (minutes). A bare integer is treated as seconds.

### `--concurrency` (optional)

Maximum number of agents to run simultaneously.

```
switchboard --watch=jira --concurrency=5
```

Default: `2 * os.cpus().length` (2x the number of logical CPU cores). On a 10-core machine this defaults to `20`. The value is read at startup via Node's `os` module, which Bun supports.

This is a hard cap. Switchboard will never have more than this many tasks in-flight at once. See **Dispatch and Backpressure** for details.

### Mode resolution

Given a `--watch` value:

1. If the value starts with `$ `, treat everything after the `$ ` as a shell command (**shell mode**).
2. If the value contains a path separator (`/`) or starts with `.`, treat it as a file path to a TypeScript module (**module mode**).
3. Otherwise, treat it as a built-in watcher name (**built-in mode**).

### Required flag

`--watch` is required. If omitted, Switchboard exits with a clear error explaining the three modes.

## Config Singleton

All parsed CLI flags are written into a singleton config object. This object is passed to the watcher factory so watchers can read Switchboard-level settings if they choose to. Watchers are free to ignore it entirely.

```ts
interface SwitchboardConfig {
  /** Parsed from --poll-interval. Milliseconds. */
  pollInterval: number

  /** Parsed from --concurrency. Max simultaneous agents. */
  concurrency: number

  /** Raw --watch value, after mode resolution. */
  watch: string
}
```

This is the only thing Switchboard passes to a watcher. Switchboard makes no assumptions about watcher-specific configuration. If a watcher needs a Jira API key, a Linear project slug, or a GitHub token, the watcher handles that itself -- reading from environment variables, a dotfile, a `.toml` in the user's home directory, or whatever else makes sense for that integration.

## Task Interface

The normalized task object that watchers return. This is deliberately minimal -- it carries only what Switchboard needs to dispatch work to an agent.

```ts
interface Task {
  /** Stable external ID from the task source (e.g., Jira issue key, GitHub issue number). */
  id: string

  /** Human-readable identifier (e.g., "PROJ-123", "#42"). Falls back to id if unset. */
  identifier?: string

  /** Task title / summary. */
  title: string

  /** Full description or body text. Null if unavailable. */
  description: string | null

  /** URL to the task in the external service. Null if unavailable. */
  url: string | null

  /** Priority as an integer. Lower is higher priority. Null if unavailable. */
  priority: number | null
}
```

No labels, no state, no timestamps. The watcher already filtered for the tasks it wants Switchboard to work on. If a task is yielded by `fetch()`, Switchboard treats it as a candidate. If it stops appearing in future `fetch()` calls, Switchboard can use that signal during reconciliation.

## Watcher Interface

```ts
interface Watcher {
  /**
   * Called on every poll tick. Yields tasks one at a time as an async
   * generator. Switchboard pulls from the generator until it fills its
   * concurrency slots, then stops. The watcher is free to stop doing
   * work at that point -- e.g., skip fetching the next page from an API.
   *
   * The watcher owns all filtering. Switchboard dispatches from
   * whatever this yields.
   */
  fetch(): AsyncGenerator<Task>
}
```

That's the whole interface. One method. Switchboard calls it, pulls tasks, stops when full.

Using a generator means the watcher controls its own memory. A Jira adapter can fetch page 1 from the API, yield those 50 tasks, and if Switchboard only needed 3 it never fetches page 2. A simple watcher with a small list can just `yield*` an array.

### Module mode

A user-provided TypeScript file must default-export a factory function that returns a `Watcher`:

```ts
// adapters/my-jira.ts
import type { Watcher, Task, SwitchboardConfig } from "switchboard"

export default function createWatcher(config: SwitchboardConfig): Watcher {
  const apiKey = process.env.JIRA_API_KEY
  const project = process.env.JIRA_PROJECT ?? "MYPROJECT"

  return {
    async *fetch() {
      let page = 0
      while (true) {
        const issues = await fetchFromJira(apiKey, project, page)
        if (issues.length === 0) break
        for (const issue of issues) {
          yield normalize(issue)
        }
        page++
      }
    },
  }
}
```

For a trivial watcher that already has all tasks in memory:

```ts
export default function createWatcher(config: SwitchboardConfig): Watcher {
  return {
    async *fetch() {
      yield* [
        { id: "1", title: "First task" },
        { id: "2", title: "Second task" },
      ]
    },
  }
}
```

Switchboard dynamically imports the module at startup:

```ts
const mod = await import(resolve(watchFlag))
const watcher = mod.default(config)
```

### Built-in mode

Built-in watchers are resolved by name from a known map:

```ts
const builtins: Record<string, string> = {
  linear: "./watchers/linear.ts",
  github: "./watchers/github.ts",
  jira:   "./watchers/jira.ts",
}
```

They use the same module interface and factory pattern. They receive the same `SwitchboardConfig`. They handle their own authentication and service-specific configuration.

### Shell mode

When `--watch` starts with `$ `, Switchboard wraps the command in an adapter:

```ts
function createShellWatcher(command: string): Watcher
```

On each poll tick, the shell adapter:

1. Executes the command via `Bun.spawn(["bash", "-lc", command])`.
2. Captures stdout.
3. Parses stdout as JSON -- either a `Task[]` array or newline-delimited JSON.
4. Yields tasks one at a time from the parsed result.

#### Shell output format

The command must write JSON to stdout. Two formats are accepted:

**Array format** -- a single JSON array:

```json
[
  {"id": "123", "identifier": "PROJ-123", "title": "Fix login bug"},
  {"id": "124", "identifier": "PROJ-124", "title": "Add dark mode"}
]
```

**NDJSON format** -- one JSON object per line:

```json
{"id": "123", "identifier": "PROJ-123", "title": "Fix login bug"}
{"id": "124", "identifier": "PROJ-124", "title": "Add dark mode"}
```

Required fields: `id` and `title`. If `identifier` is missing it defaults to `id`. All other fields default to `null`.

#### Shell mode constraints

- If the command exits non-zero, the poll tick fails gracefully (logged, dispatch skipped, retry next tick).
- Command timeout: 30 seconds. If the command hangs, it is killed and the tick fails.

## Entrypoint

### 1. CLI argument parsing

Parse flags from `Bun.argv`. No third-party parser -- the flag set is small.

```ts
function parseArgs(argv: string[]): SwitchboardConfig {
  let watch: string | undefined
  let pollInterval = 30_000 // default 30s
  let concurrency = 2 * require("os").cpus().length // default 2x CPU cores

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--watch=")) {
      watch = arg.slice("--watch=".length)
    } else if (arg.startsWith("--poll-interval=")) {
      pollInterval = parseDuration(arg.slice("--poll-interval=".length))
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = parseInt(arg.slice("--concurrency=".length), 10)
    }
  }

  if (!watch) {
    console.error("Error: --watch is required.")
    console.error("")
    console.error("Usage:")
    console.error("  switchboard --watch=jira              # built-in watcher")
    console.error("  switchboard --watch=./watcher.ts      # custom module")
    console.error('  switchboard --watch="$ command"        # shell command')
    process.exit(1)
  }

  return { watch, pollInterval, concurrency }
}
```

### 2. Watcher resolution

```ts
async function resolveWatcher(config: SwitchboardConfig): Promise<Watcher> {
  const flag = config.watch

  // Shell mode
  if (flag.startsWith("$ ")) {
    return createShellWatcher(flag.slice(2))
  }

  // Module mode
  if (flag.includes("/") || flag.startsWith(".")) {
    const mod = await import(resolve(flag))
    return mod.default(config)
  }

  // Built-in mode
  const builtinPath = builtins[flag]
  if (!builtinPath) {
    console.error(`Unknown built-in watcher: "${flag}"`)
    console.error(`Available: ${Object.keys(builtins).join(", ")}`)
    process.exit(1)
  }
  const mod = await import(builtinPath)
  return mod.default(config)
}
```

### 3. Poll loop

The poll loop calls `watcher.fetch()` on a fixed interval and pulls tasks from the returned generator until concurrency slots are full. Errors are caught and logged -- the loop never stops and Switchboard never crashes.

```ts
const config = parseArgs(Bun.argv)
const watcher = await resolveWatcher(config)
const inFlight = new Set<string>() // task IDs currently being worked on

async function tick() {
  try {
    for await (const task of watcher.fetch()) {
      // Backpressure: stop pulling from the generator when at capacity
      if (inFlight.size >= config.concurrency) break

      // Validate
      if (!task.id || !task.title) {
        console.warn(`Dropping malformed task: ${JSON.stringify(task)}`)
        continue
      }

      // Skip tasks already in-flight
      if (inFlight.has(task.id)) continue

      // Dispatch
      inFlight.add(task.id)
      dispatch(task).finally(() => inFlight.delete(task.id))
    }
  } catch (err) {
    console.error(`Watcher fetch failed: ${err}`)
  }
}

tick()
setInterval(tick, config.pollInterval)
```

## Dispatch and Backpressure

Switchboard maintains a set of in-flight task IDs. On each poll tick:

1. Call `watcher.fetch()` to get an async generator of tasks.
2. Pull tasks from the generator with `for await`.
3. Skip any task whose `id` is already in-flight.
4. **Break out of the loop** once `inFlight.size >= concurrency`. The generator is abandoned -- the watcher stops doing work (no more API pages fetched, no more rows read).
5. For each new task that fits, add it to the in-flight set and dispatch it.
6. When the dispatch resolves (success or failure), remove the task from the in-flight set.

This means Switchboard only holds up to `concurrency` tasks in memory at any time. The watcher may have thousands of tasks available, but Switchboard only pulls what it has room for. The watcher decides how to handle pagination and memory on its side -- Switchboard just stops asking for more.

Tasks are dispatched as fire-and-forget promises. The poll loop does not `await` them -- it kicks off work and moves on. The `.finally()` cleanup ensures the in-flight set stays accurate regardless of success or failure.

### Stub agent (temporary)

Until real agent dispatch is built, each dispatched task runs a no-op stub:

```ts
async function dispatch(task: Task): Promise<void> {
  const id = task.identifier ?? task.id
  console.log(`[dispatch] ${id}: ${task.title}`)
  await new Promise(resolve => setTimeout(resolve, 10_000))
  console.log(`[complete] ${id}`)
}
```

The stub:
1. Logs the task ID and title.
2. Waits 10 seconds (simulating agent work).
3. Logs completion.

This is enough to verify the full watcher-to-dispatch pipeline: polling, validation, concurrency limits, backpressure, and slot recovery.

## Error Handling

Switchboard must never crash. Every boundary where external code or I/O runs is wrapped in error handling:

1. **Watcher `fetch()` throws** -- Logged. Dispatch skipped for this tick. Next tick tries again.
2. **Shell command exits non-zero** -- Logged. Dispatch skipped.
3. **Shell command times out** -- Process killed. Logged. Dispatch skipped.
4. **Shell command returns invalid JSON** -- Logged. Dispatch skipped.
5. **Module import fails** -- This is a startup error and the only case where Switchboard exits. The user gave a bad path.
6. **Watcher returns malformed tasks** -- Individual tasks missing `id` or `title` are dropped with a warning. Valid tasks proceed.

The pattern: log and continue. The poll loop is the heartbeat. It keeps ticking.

## Validation

Switchboard validates the shape of objects returned by `fetch()` at runtime. Per-task validation:

| Field | Required | Default if missing |
|---|---|---|
| `id` | yes | task is dropped |
| `title` | yes | task is dropped |
| `identifier` | no | defaults to `id` |
| `description` | no | `null` |
| `url` | no | `null` |
| `priority` | no | `null` |

Extra fields on task objects are silently ignored.

## What Switchboard Does NOT Do

- **No watcher configuration.** Switchboard does not pass API keys, project slugs, JQL queries, or any service-specific config to watchers. Watchers own their config.
- **No state tracking via the watcher.** The watcher does not report task states. Switchboard maintains its own internal state for locking, dispatch, and deadlettering.
- **No WORKFLOW.md.** Configuration is CLI flags only. Stop and restart to change settings.
- **No dynamic reload.** Stop and start Switchboard to change the watcher or poll interval.
- **No authentication assumptions.** Built-in watchers handle auth however they see fit.

## Next Steps

The stub `dispatch()` function is a placeholder. The following work remains before Switchboard is functional:

1. **Persistent state.** Switchboard needs a way to track which tasks have been claimed, are in-flight, have completed, or have been deadlettered. This prevents re-dispatching tasks across poll ticks and across restarts. The storage mechanism is TBD (could be an in-memory structure, a file on disk, Redis, etc.).
2. **Real agent runner.** Replace the 10-second no-op with actual agent subprocess management (workspace creation, prompt construction, app-server protocol over stdio).
3. **Reconciliation.** When a task disappears from the watcher's `fetch()` response while an agent is working on it, Switchboard needs a policy for what to do (let it finish, cancel it, etc.).
4. **TUI integration.** Wire the dispatch/completion lifecycle into the existing OpenTUI shell so the status surface reflects real activity.
5. **Deadlettering.** Define what happens when a task fails repeatedly -- how many retries, backoff strategy, and how to surface deadlettered tasks to the operator.
