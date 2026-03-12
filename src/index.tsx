import { createCliRenderer, createTextAttributes } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { basename, join } from "path"
import { useState, useEffect } from "react"
import { parseArgs, formatElapsed, parseHelpAction, printMainHelp } from "./config"
import { getWatcherHelp, resolveWatcher } from "./watcher"
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

try {
  const helpAction = parseHelpAction(Bun.argv)
  if (helpAction) {
    if (helpAction.kind === "main") {
      printMainHelp()
      process.exit(0)
    }

    try {
      console.log(await getWatcherHelp(helpAction.watcher))
      process.exit(0)
    } catch (error: any) {
      console.error(error?.message ?? String(error))
      process.exit(1)
    }
  }
} catch (error: any) {
  console.error(error?.message ?? String(error))
  process.exit(1)
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
  logDir?: string
  dispatchId?: string
}

type ViewMode = "overview" | "logs"

interface LogSegment {
  text: string
  fg?: string
  bg?: string
  attributes: number
}

type LogLine = LogSegment[]

interface AnsiStyle {
  fg?: string
  bg?: string
  bold: boolean
  italic: boolean
  underline: boolean
  dim: boolean
  blink: boolean
  inverse: boolean
  strikethrough: boolean
}

const MAX_LOG_LINES = 1_000

function defaultAnsiStyle(): AnsiStyle {
  return {
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    blink: false,
    inverse: false,
    strikethrough: false,
  }
}

function colorToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) => value.toString(16).padStart(2, "0")
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function ansi256ToHex(code: number): string {
  const base = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ]

  if (code >= 0 && code <= 15) return base[code]

  if (code >= 16 && code <= 231) {
    const n = code - 16
    const r = Math.floor(n / 36)
    const g = Math.floor((n % 36) / 6)
    const b = n % 6
    const levels = [0, 95, 135, 175, 215, 255]
    return colorToHex(levels[r], levels[g], levels[b])
  }

  if (code >= 232 && code <= 255) {
    const gray = 8 + (code - 232) * 10
    return colorToHex(gray, gray, gray)
  }

  return "#ffffff"
}

function styleAttributes(style: AnsiStyle): number {
  return createTextAttributes({
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    dim: style.dim,
    blink: style.blink,
    inverse: style.inverse,
    strikethrough: style.strikethrough,
  })
}

function parseAnsiLine(line: string): LogLine {
  const segments: LogLine = []
  const re = /\x1b\[([0-9;]*)m/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let style = defaultAnsiStyle()

  const pushText = (text: string) => {
    if (!text) return
    segments.push({ text, fg: style.fg, bg: style.bg, attributes: styleAttributes(style) })
  }

  while ((match = re.exec(line)) != null) {
    pushText(line.slice(lastIndex, match.index))
    const rawCodes = match[1]
    const codes = (rawCodes.length === 0 ? [0] : rawCodes.split(";").map((value) => parseInt(value, 10))).filter(
      (value) => Number.isFinite(value),
    )

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]

      if (code === 0) {
        style = defaultAnsiStyle()
      } else if (code === 1) {
        style.bold = true
      } else if (code === 2) {
        style.dim = true
      } else if (code === 3) {
        style.italic = true
      } else if (code === 4) {
        style.underline = true
      } else if (code === 5) {
        style.blink = true
      } else if (code === 7) {
        style.inverse = true
      } else if (code === 9) {
        style.strikethrough = true
      } else if (code === 22) {
        style.bold = false
        style.dim = false
      } else if (code === 23) {
        style.italic = false
      } else if (code === 24) {
        style.underline = false
      } else if (code === 25) {
        style.blink = false
      } else if (code === 27) {
        style.inverse = false
      } else if (code === 29) {
        style.strikethrough = false
      } else if (code === 39) {
        style.fg = undefined
      } else if (code === 49) {
        style.bg = undefined
      } else if (code >= 30 && code <= 37) {
        style.fg = ansi256ToHex(code - 30)
      } else if (code >= 90 && code <= 97) {
        style.fg = ansi256ToHex(code - 90 + 8)
      } else if (code >= 40 && code <= 47) {
        style.bg = ansi256ToHex(code - 40)
      } else if (code >= 100 && code <= 107) {
        style.bg = ansi256ToHex(code - 100 + 8)
      } else if (code === 38 || code === 48) {
        const target = code === 38 ? "fg" : "bg"
        const mode = codes[i + 1]
        if (mode === 5 && i + 2 < codes.length) {
          const paletteCode = codes[i + 2]
          style[target] = ansi256ToHex(paletteCode)
          i += 2
        } else if (mode === 2 && i + 4 < codes.length) {
          const r = codes[i + 2]
          const g = codes[i + 3]
          const b = codes[i + 4]
          style[target] = colorToHex(r, g, b)
          i += 4
        }
      }
    }

    lastIndex = re.lastIndex
  }

  pushText(line.slice(lastIndex))
  return segments
}

function readLogTail(logDir: string): LogLine[] {
  if (!existsSync(logDir)) return []

  const entries = readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => {
      const filepath = join(logDir, entry.name)
      const stats = statSync(filepath)
      return { filepath, name: entry.name, mtimeMs: stats.mtimeMs }
    })
    .sort((a, b) => (a.mtimeMs === b.mtimeMs ? a.name.localeCompare(b.name) : a.mtimeMs - b.mtimeMs))

  const lines: LogLine[] = []

  for (const entry of entries) {
    lines.push([
      {
        text: `--- ${entry.name} ---`,
        fg: "#888",
        attributes: createTextAttributes({ dim: true }),
      },
    ])

    const content = readFileSync(entry.filepath, "utf8")
    for (const line of content.split("\n")) {
      lines.push(parseAnsiLine(line))
    }
  }

  if (lines.length <= MAX_LOG_LINES) return lines
  return lines.slice(lines.length - MAX_LOG_LINES)
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

function TaskTable({
  rows,
  completedCount,
  selectedIndex,
}: {
  rows: TaskRow[]
  completedCount: number
  selectedIndex: number
}) {
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
        <box width={3}>
          <text fg="#888"> </text>
        </box>
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
      {rows.map((row, index) => (
        <box key={row.task.id} flexDirection="row">
          <box width={3}>
            <text fg={index === selectedIndex ? "#22c55e" : "#444"}>{index === selectedIndex ? "›" : " "}</text>
          </box>
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
  const [viewMode, setViewMode] = useState<ViewMode>("overview")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedLogDir, setSelectedLogDir] = useState<string | null>(null)
  const [selectedTitle, setSelectedTitle] = useState<string>("")
  const [selectedIdentifier, setSelectedIdentifier] = useState<string>("")
  const [logLines, setLogLines] = useState<LogLine[]>([])

  useEffect(() => {
    setSelectedIndex((prev) => {
      if (rows.length === 0) return 0
      return Math.min(prev, rows.length - 1)
    })
  }, [rows.length])

  useEffect(() => {
    if (viewMode !== "logs" || !selectedLogDir) {
      setLogLines([])
      return
    }

    setLogLines(readLogTail(selectedLogDir))

    const id = setInterval(() => {
      setLogLines(readLogTail(selectedLogDir))
    }, 500)

    return () => clearInterval(id)
  }, [viewMode, selectedLogDir])

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
          updated[existing] = {
            ...updated[existing],
            status: event.status,
            pid: event.pid ?? updated[existing].pid,
            logDir: event.logDir ?? updated[existing].logDir,
            dispatchId: event.dispatchId ?? updated[existing].dispatchId,
          }
          return updated
        }
        return [
          ...prev,
          {
            task: event.task,
            status: event.status,
            startedAt: Date.now(),
            pid: event.pid,
            logDir: event.logDir,
            dispatchId: event.dispatchId,
          },
        ]
      })
    })
  }, [])

  useKeyboard((key) => {
    if (viewMode === "logs" && key.name === "escape") {
      setViewMode("overview")
      setSelectedLogDir(null)
      return
    }

    if (viewMode === "overview") {
      if (key.name === "up") {
        setSelectedIndex((prev) => Math.max(0, prev - 1))
        return
      }

      if (key.name === "down") {
        setSelectedIndex((prev) => (rows.length === 0 ? 0 : Math.min(rows.length - 1, prev + 1)))
        return
      }

      if ((key.name === "return" || key.name === "enter") && rows.length > 0) {
        const row = rows[selectedIndex]
        if (!row?.logDir) return
        setSelectedIdentifier(row.task.identifier ?? row.task.id)
        setSelectedTitle(row.task.title)
        setSelectedLogDir(row.logDir)
        setViewMode("logs")
        return
      }
    }

    if (key.name === "q") {
      shutdown()
    }
  })

  return (
    <box flexDirection="column" style={{ padding: 1 }}>
      <ascii-font text="Switchboard" font="tiny" />

      {viewMode === "overview" ? (
        <TaskTable rows={rows} completedCount={completedCount} selectedIndex={selectedIndex} />
      ) : (
        <box flexDirection="column" style={{ marginTop: 1 }} flexGrow={1} minHeight={0}>
          <box>
            <text>
              <span fg="#22c55e">Logs</span>
              <span fg="#555"> | {selectedIdentifier}</span>
              <span fg="#555"> | {basename(selectedLogDir ?? "")}</span>
              <span fg="#555"> | {selectedTitle}</span>
            </text>
          </box>

          <box flexGrow={1} minHeight={0} style={{ marginTop: 1 }}>
            <scrollbox stickyScroll stickyStart="bottom" focused style={{ width: "100%", height: "100%" }}>
              <box flexDirection="column">
                {logLines.map((line, index) => (
                  <text key={`line-${index}`} wrapMode="none">
                    {line.map((segment, segmentIndex) => (
                      <span
                        key={`line-${index}-segment-${segmentIndex}`}
                        fg={segment.fg}
                        bg={segment.bg}
                        attributes={segment.attributes}
                      >
                        {segment.text}
                      </span>
                    ))}
                  </text>
                ))}
              </box>
            </scrollbox>
          </box>
        </box>
      )}

      <box style={{ marginTop: 1 }}>
        <text>
          <span fg="#22c55e">Polling ({config.waitBetweenPolls / 1000}s)</span>
          <span fg="#555">
            {" "}| Watcher: {config.watch} | Agent: {config.agent} | Concurrency: {config.concurrency}
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
          {viewMode === "overview" ? (
            <>
              <span fg="#888">↑/↓</span> select | <span fg="#888">Enter</span> view logs | <span fg="#888">q</span> quit
            </>
          ) : (
            <>
              <span fg="#888">Esc</span> back to processes | <span fg="#888">q</span> quit
            </>
          )}
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
