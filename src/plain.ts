import { formatElapsed, renderAsciiText } from "./config"
import type { TaskEvent } from "./orchestrator"
import type { Task } from "./types"
import type { SwitchboardConfig } from "./types"

type TaskRowStatus = "in_progress" | "complete" | "error"

interface TaskRow {
  task: Task
  status: TaskRowStatus
  startedAt: number
  pid?: number
}

function statusLabel(status: TaskRowStatus): string {
  switch (status) {
    case "in_progress":
      return "running"
    case "complete":
      return "done"
    case "error":
      return "error"
  }
}

function formatRow(row: TaskRow): string {
  const status = statusLabel(row.status).padEnd(10)
  const elapsed = formatElapsed(Date.now() - row.startedAt).padEnd(10)
  const pid = (row.pid != null ? String(row.pid) : "—").padEnd(10)
  const key = (row.task.identifier ?? row.task.id).padEnd(14)
  const title = row.task.title
  return `${status}${elapsed}${pid}${key}${title}`
}

/**
 * Start plain (non-TUI) output mode. Prints the ASCII header once,
 * then logs a line for each task event as it arrives.
 *
 * Returns a shutdown function.
 */
export function startPlainOutput(
  config: SwitchboardConfig,
  orchestrator: { start(): () => void; onTaskEvent(listener: (e: TaskEvent) => void): () => void },
): () => void {
  // Print the ASCII art header
  console.log(renderAsciiText("Switchboard"))
  console.log("")
  console.log(
    `Polling (${config.waitBetweenPolls / 1000}s) | Watcher: ${config.watch} | Concurrency: ${config.concurrency}`,
  )
  console.log("")

  // Print column headers
  console.log(
    `${"Status".padEnd(10)}${"Elapsed".padEnd(10)}${"PID".padEnd(10)}${"Key".padEnd(14)}Title`,
  )

  // Subscribe to task events and print each change
  const rows = new Map<string, TaskRow>()

  const unsubscribe = orchestrator.onTaskEvent((event: TaskEvent) => {
    if (event.status === "complete" || event.status === "error") {
      // Print the final state, then remove from tracking
      const row: TaskRow = {
        task: event.task,
        status: event.status,
        startedAt: rows.get(event.task.id)?.startedAt ?? Date.now(),
        pid: event.pid ?? rows.get(event.task.id)?.pid,
      }
      console.log(formatRow(row))
      rows.delete(event.task.id)
    } else {
      // in_progress — track and print
      const existing = rows.get(event.task.id)
      const row: TaskRow = {
        task: event.task,
        status: event.status,
        startedAt: existing?.startedAt ?? Date.now(),
        pid: event.pid ?? existing?.pid,
      }
      rows.set(event.task.id, row)
      console.log(formatRow(row))
    }
  })

  const stopPolling = orchestrator.start()

  return () => {
    stopPolling()
    unsubscribe()
  }
}
