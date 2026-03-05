import type { SwitchboardConfig, Watcher, Task, PutContext } from "../types"
import { appendFileSync } from "fs"
import { join, parse as parsePath } from "path"

/**
 * Normalize a raw object from NDJSON into a Task, or null if invalid.
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
 * Resolve the path to the completed-tasks file.
 *
 * If WATCHER_FILE_COMPLETE is set, use that directly. Otherwise derive
 * a sibling path from the source: `foo.ndjson` → `foo-completed.ndjson`.
 */
function resolveCompletedPath(sourcePath: string): string {
  if (process.env.WATCHER_FILE_COMPLETE) {
    return process.env.WATCHER_FILE_COMPLETE
  }
  const { dir, name, ext } = parsePath(sourcePath)
  return join(dir || ".", `${name}-completed${ext}`)
}

/**
 * Read the completed-tasks file and return a Set of task IDs that
 * have already been processed. Returns an empty set if the file
 * does not exist yet.
 */
async function loadCompletedIds(completedPath: string): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    const content = await Bun.file(completedPath).text()
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        const id =
          typeof parsed.id === "number" ? String(parsed.id) : parsed.id
        if (typeof id === "string") ids.add(id)
      } catch {
        // Skip malformed lines in the completed file.
      }
    }
  } catch {
    // File doesn't exist yet — no completed tasks.
  }
  return ids
}

/**
 * Create a Watcher that reads NDJSON from a file or socket.
 *
 * Set WATCHER_FILE to the path of a regular file, named pipe (FIFO),
 * or Unix domain socket. Each line must be a JSON object conforming
 * to the Task shape (at minimum `id` and `title`).
 *
 * For regular files the generator reads all lines and returns.
 * For pipes and sockets it streams lines as they arrive, yielding
 * tasks in real-time until the writer closes the connection.
 *
 * Completed tasks are recorded in a separate file so the source is
 * never modified. Set WATCHER_FILE_COMPLETE to override the default
 * path (`<name>-completed.<ext>` next to the source file).
 */
export default function createWatcher(_config: SwitchboardConfig): Watcher {
  const filePath = process.env.WATCHER_FILE
  if (!filePath) {
    throw new Error("Missing required environment variable: WATCHER_FILE")
  }

  const completedPath = resolveCompletedPath(filePath)

  return {
    async *fetch(): AsyncGenerator<Task> {
      // Load the set of already-completed task IDs so we skip them.
      const completedIds = await loadCompletedIds(completedPath)

      const file = Bun.file(filePath)
      const decoder = new TextDecoder()
      let buffer = ""

      for await (const chunk of file.stream()) {
        buffer +=
          typeof chunk === "string"
            ? chunk
            : decoder.decode(new Uint8Array(chunk), { stream: true })

        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)

          if (!line) continue

          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            console.error(`File watcher: skipping invalid JSON line: ${line}`)
            continue
          }

          const task = normalizeTask(parsed)
          if (task && !completedIds.has(task.id)) {
            yield task
          }
        }
      }

      // Handle any remaining data after stream ends (no trailing newline)
      const remaining = (buffer + decoder.decode()).trim()
      if (remaining) {
        try {
          const parsed = JSON.parse(remaining)
          const task = normalizeTask(parsed)
          if (task && !completedIds.has(task.id)) {
            yield task
          }
        } catch {
          console.error(
            `File watcher: skipping invalid JSON at end of stream: ${remaining}`
          )
        }
      }
    },

    async put(task: Task, _context: PutContext): Promise<void> {
      // Task is a pure DTO — JSON.stringify works cleanly.
      appendFileSync(completedPath, JSON.stringify(task) + "\n")
    },
  }
}
