import type { SwitchboardConfig, Watcher, Task } from "../types"

/**
 * Normalize a raw object from shell output into a Task, or null if invalid.
 */
function normalizeTask(raw: unknown): Task | null {
  if (typeof raw !== "object" || raw === null) return null
  const obj = raw as Record<string, unknown>

  const id =
    typeof obj.id === "string"
      ? obj.id
      : typeof obj.id === "number"
        ? String(obj.id)
        : undefined
  const title = typeof obj.title === "string" ? obj.title : undefined

  if (!id || !title) return null

  return {
    id,
    title,
    identifier: typeof obj.identifier === "string" ? obj.identifier : undefined,
    description: typeof obj.description === "string" ? obj.description : null,
    url: typeof obj.url === "string" ? obj.url : null,
    priority: typeof obj.priority === "number" ? obj.priority : null,
  }
}

/**
 * Create a Watcher that executes a shell command on each poll tick.
 *
 * The command is extracted from config.watch by stripping the leading "$ " prefix.
 * The command must write JSON to stdout -- either a JSON array of tasks
 * or newline-delimited JSON (one object per line).
 *
 * Timeout: 30 seconds. Non-zero exit codes and invalid JSON are logged
 * and the tick is skipped gracefully.
 */
export default function createWatcher(config: SwitchboardConfig): Watcher {
  const command = config.watch.startsWith("$ ")
    ? config.watch.slice(2)
    : config.watch

  return {
    async *fetch(): AsyncGenerator<Task> {
      const proc = Bun.spawn(["bash", "-lc", command], {
        stdout: "pipe",
        stderr: "pipe",
      })

      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, 30_000)

      let stdout: string
      let stderr: string
      let exitCode: number

      try {
        ;[stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
      } finally {
        clearTimeout(timeout)
      }

      if (timedOut) {
        console.error("Shell watcher timed out after 30s")
        return
      }

      if (exitCode !== 0) {
        console.error(
          `Shell watcher exited with code ${exitCode}: ${stderr.trim()}`
        )
        return
      }

      const trimmed = stdout.trim()
      if (!trimmed) return

      let items: unknown[]
      try {
        if (trimmed.startsWith("[")) {
          // Array format
          items = JSON.parse(trimmed)
        } else {
          // NDJSON format -- one JSON object per line
          items = trimmed.split("\n").map((line) => JSON.parse(line))
        }
      } catch {
        console.error("Shell watcher returned invalid JSON")
        return
      }

      for (const item of items) {
        const task = normalizeTask(item)
        if (task) {
          yield task
        }
      }
    },
  }
}
