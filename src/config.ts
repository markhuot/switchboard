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
 * Supported suffixes: s (seconds), m (minutes). Bare integer = seconds.
 */
export function parseDuration(value: string): number {
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
 * Parse CLI flags from argv into a SwitchboardConfig.
 * Exits with usage info if --watch is missing.
 */
export function parseArgs(argv: string[]): SwitchboardConfig {
  let watch: string | undefined
  let agent: string | undefined
  let dispatch = ".switchboard/commands/"
  let pollInterval = 30_000 // default 30s
  let concurrency = 2 * os.cpus().length // default 2x CPU cores

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--watch=")) {
      watch = arg.slice("--watch=".length)
    } else if (arg.startsWith("--agent=")) {
      agent = arg.slice("--agent=".length)
    } else if (arg.startsWith("--dispatch=")) {
      dispatch = arg.slice("--dispatch=".length)
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
    console.error("  switchboard --watch=jira --agent=opencode")
    console.error("  switchboard --watch=./watcher.ts --agent=claude")
    console.error('  switchboard --watch="$ command" --agent=./my-agent')
    process.exit(1)
  }

  if (!agent) {
    console.error("Error: --agent is required.")
    console.error("")
    console.error("Usage:")
    console.error("  switchboard --watch=jira --agent=opencode")
    console.error("  switchboard --watch=jira --agent=claude")
    console.error("  switchboard --watch=jira --agent=./agents/my-agent")
    process.exit(1)
  }

  return { watch, agent, dispatch, pollInterval, concurrency }
}
