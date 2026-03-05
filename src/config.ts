import { fonts } from "@opentui/core"
import os from "os"
import type { SwitchboardConfig } from "./types"

/**
 * Format milliseconds into a human-readable elapsed duration.
 * Shows at most two units, e.g. "1m 32s", "3h 14m", "4y 2d".
 * Returns "0s" for durations under one second.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const units: [string, number][] = [
    ["y", 365 * 24 * 60 * 60],
    ["d", 24 * 60 * 60],
    ["h", 60 * 60],
    ["m", 60],
    ["s", 1],
  ]

  const parts: string[] = []
  let remaining = totalSeconds

  for (const [label, size] of units) {
    if (remaining >= size) {
      const count = Math.floor(remaining / size)
      remaining %= size
      parts.push(`${count}${label}`)
      if (parts.length === 2) break
    }
  }

  return parts.length > 0 ? parts.join(" ") : "0s"
}

/**
 * Parse a human-readable duration string into milliseconds.
 * Supported suffixes: s (seconds), m (minutes), h (hours). Bare integer = seconds.
 */
export function parseDuration(value: string): number {
  if (value.endsWith("h")) {
    return parseInt(value.slice(0, -1), 10) * 3_600_000
  }
  if (value.endsWith("m")) {
    return parseInt(value.slice(0, -1), 10) * 60_000
  }
  if (value.endsWith("s")) {
    return parseInt(value.slice(0, -1), 10) * 1_000
  }
  // Bare integer treated as seconds
  return parseInt(value, 10) * 1_000
}

/**
 * Render a text string using the "tiny" ASCII font from OpenTUI,
 * returning the multi-line result as a plain string.
 */
export function renderAsciiText(text: string): string {
  const font = fonts.tiny
  const lineCount = font.lines
  const lines: string[] = Array.from({ length: lineCount }, () => "")

  for (const ch of text.toUpperCase()) {
    const glyph = font.chars[ch as keyof typeof font.chars]
    if (!glyph) continue
    for (let i = 0; i < lineCount; i++) {
      lines[i] += (glyph[i] ?? "") + font.letterspace[i]
    }
  }

  return lines.map((l) => l.trimEnd()).join("\n")
}

/**
 * Print full CLI help text to stdout.
 */
function printHelp(): void {
  console.log(`${renderAsciiText("Switchboard")}

Switchboard — a composable task orchestrator for coding agents

Usage:
  switchboard --watch=<source> --agent=<agent> [options]

Required:
  --watch=<source>          Task source to poll for work.
                            Built-in:  jira, github, linear, file, shell
                            Module:    ./path/to/watcher.ts
                            Shell:     "$ <command>"

  --agent=<agent>           Agent to dispatch tasks to.
                            Examples:  opencode, claude, ./agents/my-agent

Options:
  --dispatch=<path>         Path to the commands directory.
                            (default: .switchboard/commands/)

  --wait-between-polls=<dur>
                            How long to wait between polling passes.
                            Accepts: 30s, 5m, or bare integer (seconds).
                            (default: 30s)

  --task-ttl=<dur>          Maximum time a lock can be held before it is
                            considered stale. Accepts: 30m, 2h, or bare
                            integer (seconds).
                            (default: 1h)

  --concurrency=<n>         Max simultaneous agent processes.
                            (default: 2x CPU cores, currently ${2 * os.cpus().length})

  --no-tty                  Disable the full-screen TUI and print plain
                            line-by-line output instead. Automatically
                            enabled when stdout is not a TTY or the CI
                            environment variable is set.

  -h, --help                Show this help message and exit.

Examples:
  switchboard --watch=jira --agent=opencode
  switchboard --watch=github --agent=claude --wait-between-polls=1m
  switchboard --watch=./watcher.ts --agent=./agents/my-agent --concurrency=4
  switchboard --watch="$ curl -s https://api.example.com/tasks" --agent=opencode
  CI=true switchboard --watch=jira --agent=opencode`)
}

/**
 * Parse CLI flags from argv into a SwitchboardConfig.
 * Exits with usage info if --watch is missing.
 */
export function parseArgs(argv: string[]): SwitchboardConfig {
  let watch: string | undefined
  let agent: string | undefined
  let dispatch = ".switchboard/commands/"
  let waitBetweenPolls = 30_000 // default 30s
  let taskTtl = 3_600_000 // default 1h
  let concurrency = 2 * os.cpus().length // default 2x CPU cores
  let noTtyFlag = false

  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else if (arg.startsWith("--watch=")) {
      watch = arg.slice("--watch=".length)
    } else if (arg.startsWith("--agent=")) {
      agent = arg.slice("--agent=".length)
    } else if (arg.startsWith("--dispatch=")) {
      dispatch = arg.slice("--dispatch=".length)
    } else if (arg.startsWith("--wait-between-polls=")) {
      waitBetweenPolls = parseDuration(arg.slice("--wait-between-polls=".length))
    } else if (arg.startsWith("--task-ttl=")) {
      taskTtl = parseDuration(arg.slice("--task-ttl=".length))
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = parseInt(arg.slice("--concurrency=".length), 10)
    } else if (arg === "--no-tty") {
      noTtyFlag = true
    }
  }

  // Resolve non-interactive mode: explicit flag, CI env, or not a TTY
  const noTty = noTtyFlag || !!process.env.CI || !process.stdout.isTTY

  if (!watch) {
    console.error("Error: --watch is required. Run with --help for usage information.")
    process.exit(1)
  }

  if (!agent) {
    console.error("Error: --agent is required. Run with --help for usage information.")
    process.exit(1)
  }

  return { watch, agent, dispatch, waitBetweenPolls, taskTtl, concurrency, noTty }
}
