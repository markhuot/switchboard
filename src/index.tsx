import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useState, useEffect } from "react"
import { parseArgs, formatElapsed } from "./config"
import { resolveWatcher } from "./watcher"
import { createOrchestrator } from "./orchestrator"
import { createDispatcher } from "./dispatcher"
import { createLockStore } from "./lock-store"
import { ensureSwitchboardDir } from "./filesystem"
import { startPlainOutput } from "./plain"
import { runExport } from "./export"
import type { TaskEvent } from "./orchestrator"
import type { Task } from "./types"

// 0. Check for subcommands before normal boot
if (Bun.argv[2] === "export") {
  runExport(Bun.argv)
  // runExport calls process.exit, but guard just in case
  process.exit(0)
}

// 1. Parse CLI args (exits if --watch or --agent is missing)
const config = parseArgs(Bun.argv)

// 2. Ensure .switchboard/ directory exists with a .gitignore
ensureSwitchboardDir(process.cwd())

// 2. Resolve the watcher (exits if built-in name is unknown or module fails to load)
const watcher = await resolveWatcher(config)

// 3. Create the dispatcher, lock store, and orchestrator
const dispatch = createDispatcher({ config })
const lockStore = createLockStore(config)
const orchestrator = createOrchestrator(config, watcher, dispatch, lockStore)

type TaskRowStatus = "in_progress" | "complete" | "error"

interface TaskRow {
  task: Task
  status: TaskRowStatus
  startedAt: number
  pid?: number
}

function StatusIndicator({ status }: { status: TaskRowStatus }) {
  switch (status) {
    case "in_progress":
      return <span fg="#eab308">running</span>
    case "complete":
      return <span fg="#22c55e">done</span>
    case "error":
      return <span fg="#ef4444">error</span>
  }
}

function TaskTable({ rows, completedCount }: { rows: TaskRow[]; completedCount: number }) {
  // Tick every second so elapsed times stay current
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (rows.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [rows.length > 0])

  if (rows.length === 0) {
    return (
      <box style={{ marginTop: 1 }}>
        <text fg="#555">
          {completedCount > 0
            ? "All tasks completed. Waiting for new tasks..."
            : "Waiting for tasks..."}
        </text>
      </box>
    )
  }

  return (
    <box flexDirection="column" style={{ marginTop: 1 }}>
      {/* Header */}
      <box flexDirection="row">
        <box width={10}>
          <text fg="#888">Status</text>
        </box>
        <box width={10}>
          <text fg="#888">Elapsed</text>
        </box>
        <box width={10}>
          <text fg="#888">PID</text>
        </box>
        <box width={14}>
          <text fg="#888">Key</text>
        </box>
        <box flexGrow={1}>
          <text fg="#888">Title</text>
        </box>
      </box>
      {/* Rows */}
      {rows.map((row) => (
        <box key={row.task.id} flexDirection="row">
          <box width={10}>
            <text>
              <StatusIndicator status={row.status} />
            </text>
          </box>
          <box width={10}>
            <text fg="#888">{formatElapsed(now - row.startedAt)}</text>
          </box>
          <box width={10}>
            <text fg="#888">{row.pid != null ? String(row.pid) : "—"}</text>
          </box>
          <box width={14}>
            <text fg="#6b9fff">{row.task.identifier ?? row.task.id}</text>
          </box>
          <box flexGrow={1} minWidth={0} overflow="hidden">
            <text truncate wrapMode="none">{row.task.title}</text>
          </box>
        </box>
      ))}
    </box>
  )
}

function App() {
  const [rows, setRows] = useState<TaskRow[]>([])
  const [completedCount, setCompletedCount] = useState(0)

  useEffect(() => {
    return orchestrator.onTaskEvent((event: TaskEvent) => {
      if (event.status === "complete") {
        // Remove from the table and tick the counter — no need to keep
        // finished task objects in memory.
        setRows((prev) => prev.filter((r) => r.task.id !== event.task.id))
        setCompletedCount((c) => c + 1)
        return
      }

      setRows((prev) => {
        const existing = prev.findIndex((r) => r.task.id === event.task.id)
        if (existing >= 0) {
          const updated = [...prev]
          updated[existing] = { ...updated[existing], status: event.status, pid: event.pid ?? updated[existing].pid }
          return updated
        }
        return [
          ...prev,
          { task: event.task, status: event.status, startedAt: Date.now(), pid: event.pid },
        ]
      })
    })
  }, [])

  useKeyboard((key) => {
    if (key.name === "q") {
      shutdown()
    }
  })

  return (
    <box flexDirection="column" style={{ padding: 1 }}>
      <ascii-font text="Switchboard" font="tiny" />

      <TaskTable rows={rows} completedCount={completedCount} />

      <box style={{ marginTop: 1 }}>
        <text>
          <span fg="#22c55e">Polling ({config.waitBetweenPolls / 1000}s)</span>
          <span fg="#555">
            {" "}| Watcher: {config.watch} | Concurrency: {config.concurrency}
          </span>
          {completedCount > 0 && (
            <>
              <span fg="#555"> | </span>
              <span fg="#22c55e">Completed: {completedCount}</span>
            </>
          )}
        </text>
      </box>

      <box style={{ marginTop: 1 }}>
        <text fg="#444">
          Press <span fg="#888">q</span> to quit
        </text>
      </box>
    </box>
  )
}

let shutdown: () => void

if (config.noTty) {
  // ── Plain (non-interactive) output mode ──────────────────────────
  const stop = startPlainOutput(config, orchestrator)

  shutdown = () => {
    stop()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
} else {
  // ── Full-screen TUI mode ─────────────────────────────────────────
  const renderer = await createCliRenderer({
    // onDestroy fires *after* the native renderer has restored the terminal
    // (cursor visibility, alternate screen, raw mode, etc.), so it is the
    // safe place to call process.exit.
    onDestroy: () => {
      process.exit(0)
    },
  })
  createRoot(renderer).render(<App />)

  // Start the poll loop — late subscribers will catch up via event replay.
  const stopPolling = orchestrator.start()

  // When the renderer is destroyed — whether by our shutdown() or by
  // OpenTUI's built-in Ctrl+C handler — stop polling immediately.
  renderer.on("destroy", () => {
    stopPolling()
  })

  // Graceful shutdown: destroying the renderer triggers the cleanup above.
  shutdown = () => {
    renderer.destroy()
  }
}

export { shutdown }
