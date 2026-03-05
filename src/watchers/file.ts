import type { SwitchboardConfig, Watcher, Task } from "../types"

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
 * Create a Watcher that reads NDJSON from a file or socket.
 *
 * Set WATCHER_FILE to the path of a regular file, named pipe (FIFO),
 * or Unix domain socket. Each line must be a JSON object conforming
 * to the Task shape (at minimum `id` and `title`).
 *
 * For regular files the generator reads all lines and returns.
 * For pipes and sockets it streams lines as they arrive, yielding
 * tasks in real-time until the writer closes the connection.
 */
export default function createWatcher(_config: SwitchboardConfig): Watcher {
  const filePath = process.env.WATCHER_FILE
  if (!filePath) {
    throw new Error("Missing required environment variable: WATCHER_FILE")
  }

  return {
    async *fetch(): AsyncGenerator<Task> {
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
          if (task) {
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
          if (task) {
            yield task
          }
        } catch {
          console.error(
            `File watcher: skipping invalid JSON at end of stream: ${remaining}`
          )
        }
      }
    },
  }
}
