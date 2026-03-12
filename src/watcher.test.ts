import { describe, test, expect, mock } from "bun:test"
import { resolveWatcher } from "./watcher"
import type { Task } from "./types"
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync, rmSync } from "fs"

const HELP_EXPORT_SNIPPET = `
export function help() {
  return "test watcher help"
}`

// --- resolveWatcher ---

describe("resolveWatcher", () => {
  // -- Shell mode --

  test("shell mode: resolves when flag starts with '$ '", async () => {
    const watcher = await resolveWatcher({
      watch: '$ echo \'[{"id":"1","title":"Shell task"}]\'',
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("1")
    expect(tasks[0].title).toBe("Shell task")
  })

  test("shell mode: strips the '$ ' prefix before passing to shell watcher", async () => {
    // The actual command is `echo '[...]'`, not `$ echo '[...]'`
    const watcher = await resolveWatcher({
      watch: '$ printf \'{"id":"a","title":"T1"}\\n{"id":"b","title":"T2"}\'',
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(2)
    expect(tasks[0].id).toBe("a")
    expect(tasks[1].id).toBe("b")
  })

  // -- Module mode --

  test("module mode: resolves path starting with './'", async () => {
    mkdirSync(".tmp", { recursive: true })
    writeFileSync(
      ".tmp/watcher-dot-slash.ts",
      `export default function createWatcher(config) {
        return {
          async *fetch() {
            yield { id: "mod-1", title: "Dot-slash module", description: null, url: null, priority: null }
          },
        }
      }
      ${HELP_EXPORT_SNIPPET}`
    )

    const watcher = await resolveWatcher({
      watch: "./.tmp/watcher-dot-slash.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("mod-1")
    expect(tasks[0].title).toBe("Dot-slash module")
  })

  test("module mode: resolves path containing '/'", async () => {
    mkdirSync(".tmp/sub", { recursive: true })
    writeFileSync(
      ".tmp/sub/watcher-slash.ts",
      `export default function createWatcher(config) {
        return {
          async *fetch() {
            yield { id: "sub-1", title: "Sub module", description: null, url: null, priority: null }
          },
        }
      }
      ${HELP_EXPORT_SNIPPET}`
    )

    const watcher = await resolveWatcher({
      watch: ".tmp/sub/watcher-slash.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("sub-1")
    expect(tasks[0].title).toBe("Sub module")
  })

  test("module mode: passes config to the module's default export", async () => {
    mkdirSync(".tmp", { recursive: true })
    writeFileSync(
      ".tmp/watcher-with-config.ts",
      `export default function createWatcher(config) {
        return {
          async *fetch() {
            yield {
              id: "cfg",
              title: "concurrency=" + config.concurrency,
              description: null,
              url: null,
              priority: null,
            }
          },
        }
      }
      ${HELP_EXPORT_SNIPPET}`
    )

    const watcher = await resolveWatcher({
      watch: "./.tmp/watcher-with-config.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 5_000,
      concurrency: 42,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks[0].title).toBe("concurrency=42")
  })

  // -- Built-in mode --

  test("built-in mode: resolves 'jira' to the jira watcher", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "test-token"
    process.env.JIRA_WATCH_COLUMN = "Backlog"
    process.env.JIRA_DOING_COLUMN = "Doing"
    process.env.JIRA_DONE_COLUMN = "Done"

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({ startAt: 0, maxResults: 10, total: 0, issues: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as any

    try {
      const watcher = await resolveWatcher({
        watch: "jira",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
        })
      expect(typeof watcher.fetch).toBe("function")

      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.JIRA_BASE_URL
      delete process.env.JIRA_TOKEN
      delete process.env.JIRA_WATCH_COLUMN
      delete process.env.JIRA_DOING_COLUMN
      delete process.env.JIRA_DONE_COLUMN
    }
  })

  test("built-in mode: exits with error for unknown watcher name", async () => {
    const errors: string[] = []
    const originalError = console.error
    console.error = mock((...args: any[]) => {
      errors.push(args.join(" "))
    }) as any

    const originalExit = process.exit
    let exitCode: number | undefined
    process.exit = mock((code?: number) => {
      exitCode = code
      throw new Error("process.exit called")
    }) as any

    try {
      await resolveWatcher({
        watch: "nonexistent",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
        })
    } catch (e: any) {
      expect(e.message).toBe("process.exit called")
    } finally {
      console.error = originalError
      process.exit = originalExit
    }

    expect(exitCode).toBe(1)
    expect(errors.some((msg) => msg.includes('Unknown built-in watcher: "nonexistent"'))).toBe(true)
    expect(errors.some((msg) => msg.includes("Available: linear, github, jira, shell, file, trackdown"))).toBe(true)
  })

  test("built-in mode: lists all available watchers in error message", async () => {
    const errors: string[] = []
    const originalError = console.error
    console.error = mock((...args: any[]) => {
      errors.push(args.join(" "))
    }) as any

    const originalExit = process.exit
    process.exit = mock(() => {
      throw new Error("process.exit called")
    }) as any

    try {
      await resolveWatcher({
        watch: "bogus",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
        })
    } catch {
      // expected
    } finally {
      console.error = originalError
      process.exit = originalExit
    }

    const availableMsg = errors.find((msg) => msg.includes("Available:"))
    expect(availableMsg).toBeDefined()
    expect(availableMsg).toContain("linear")
    expect(availableMsg).toContain("github")
    expect(availableMsg).toContain("jira")
    expect(availableMsg).toContain("file")
  })

  // -- File watcher (built-in) --

  test("built-in mode: resolves 'file' and reads NDJSON from a file", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/tasks.ndjson"
    writeFileSync(
      filePath,
      [
        JSON.stringify({ id: "f1", title: "File task one" }),
        JSON.stringify({ id: "f2", title: "File task two", description: "desc", url: "https://example.com", priority: 3 }),
      ].join("\n") + "\n"
    )

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })
      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(2)
      expect(tasks[0]).toEqual({
        id: "f1",
        title: "File task one",
        identifier: undefined,
        description: null,
        url: null,
        priority: null,
      })
      expect(tasks[1]).toEqual({
        id: "f2",
        title: "File task two",
        identifier: undefined,
        description: "desc",
        url: "https://example.com",
        priority: 3,
      })
    } finally {
      delete process.env.WATCHER_FILE
      unlinkSync(filePath)
    }
  })

  test("built-in mode: file watcher skips invalid JSON lines gracefully", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/tasks-bad.ndjson"
    writeFileSync(
      filePath,
      [
        JSON.stringify({ id: "ok1", title: "Good task" }),
        "this is not json",
        JSON.stringify({ id: "ok2", title: "Another good task" }),
      ].join("\n") + "\n"
    )

    process.env.WATCHER_FILE = filePath
    const originalError = console.error
    const errors: string[] = []
    console.error = mock((...args: any[]) => {
      errors.push(args.join(" "))
    }) as any

    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })
      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(2)
      expect(tasks[0].id).toBe("ok1")
      expect(tasks[1].id).toBe("ok2")
      expect(errors.some((msg) => msg.includes("skipping invalid JSON"))).toBe(true)
    } finally {
      console.error = originalError
      delete process.env.WATCHER_FILE
      unlinkSync(filePath)
    }
  })

  test("built-in mode: file watcher handles last line without trailing newline", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/tasks-no-newline.ndjson"
    writeFileSync(
      filePath,
      JSON.stringify({ id: "no-nl", title: "No trailing newline" })
    )

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })
      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(1)
      expect(tasks[0].id).toBe("no-nl")
    } finally {
      delete process.env.WATCHER_FILE
      unlinkSync(filePath)
    }
  })

  test("built-in mode: file watcher throws when WATCHER_FILE is not set", async () => {
    delete process.env.WATCHER_FILE
    expect(
      resolveWatcher({
        watch: "file",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })
    ).rejects.toThrow("Missing required environment variable: WATCHER_FILE")
  })

  test("built-in mode: file watcher skips objects missing required fields", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/tasks-incomplete.ndjson"
    writeFileSync(
      filePath,
      [
        JSON.stringify({ id: "1" }),           // missing title
        JSON.stringify({ title: "No ID" }),     // missing id
        JSON.stringify({ id: "3", title: "Valid" }),
      ].join("\n") + "\n"
    )

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })
      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(1)
      expect(tasks[0].id).toBe("3")
    } finally {
      delete process.env.WATCHER_FILE
      unlinkSync(filePath)
    }
  })

  // -- Edge cases --

  test("does not treat '$ ' in the middle of a flag as shell mode", async () => {
    // A flag like "my$ watcher" contains "$ " but does not start with it,
    // and it contains no "/" and doesn't start with ".", so it falls to built-in mode.
    const originalExit = process.exit
    const originalError = console.error
    let exitCalled = false

    console.error = mock(() => {}) as any
    process.exit = mock(() => {
      exitCalled = true
      throw new Error("process.exit called")
    }) as any

    try {
      await resolveWatcher({
        watch: "my$ watcher",
        agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
        })
    } catch {
      // expected -- unknown built-in
    } finally {
      console.error = originalError
      process.exit = originalExit
    }

    // It should have hit the built-in path and failed (not the shell path)
    expect(exitCalled).toBe(true)
  })

  test("module mode: path starting with '..' is treated as module", async () => {
    // ".." starts with "." so it should be treated as module mode
    mkdirSync(".tmp", { recursive: true })
    writeFileSync(
      ".tmp/watcher-parent.ts",
      `export default function createWatcher(config) {
        return {
          async *fetch() {
            yield { id: "parent-1", title: "Parent path module", description: null, url: null, priority: null }
          },
        }
      }
      ${HELP_EXPORT_SNIPPET}`
    )

    // Use a relative path with ".." -- we go from src/ up to project root then into .tmp/
    const watcher = await resolveWatcher({
      watch: "../switchboard/.tmp/watcher-parent.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("parent-1")
  })

  // -- File watcher complete() and completed-file filtering --

  test("file watcher complete() appends to the completed file without modifying the source", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/put-basic.ndjson"
    const completedPath = ".tmp/put-basic-completed.ndjson"
    const originalContent = [
      JSON.stringify({ id: "a", title: "Task A" }),
      JSON.stringify({ id: "b", title: "Task B" }),
      JSON.stringify({ id: "c", title: "Task C" }),
    ].join("\n") + "\n"
    writeFileSync(filePath, originalContent)

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
        dispatch: ".switchboard/commands/",
        pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })

      await watcher.complete!({
        id: "b",
        title: "Task B",
        description: null,
        url: null,
        priority: null,
      }, { summarize: async () => "", output: {} })

      // Source file must be untouched
      expect(readFileSync(filePath, "utf-8")).toBe(originalContent)

      // Completed file should have task b
      const completed = readFileSync(completedPath, "utf-8")
      const completedLines = completed.split("\n").filter((l) => l.trim())
      expect(completedLines).toHaveLength(1)
      expect(JSON.parse(completedLines[0]).id).toBe("b")
    } finally {
      delete process.env.WATCHER_FILE
      if (existsSync(filePath)) unlinkSync(filePath)
      if (existsSync(completedPath)) unlinkSync(completedPath)
    }
  })

  test("file watcher fetch() skips tasks that appear in the completed file", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/fetch-skip.ndjson"
    const completedPath = ".tmp/fetch-skip-completed.ndjson"
    writeFileSync(
      filePath,
      [
        JSON.stringify({ id: "a", title: "Task A" }),
        JSON.stringify({ id: "b", title: "Task B" }),
        JSON.stringify({ id: "c", title: "Task C" }),
      ].join("\n") + "\n"
    )
    // Pre-populate the completed file with task b
    writeFileSync(completedPath, JSON.stringify({ id: "b" }) + "\n")

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
        dispatch: ".switchboard/commands/",
        pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })

      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(2)
      expect(tasks[0].id).toBe("a")
      expect(tasks[1].id).toBe("c")
    } finally {
      delete process.env.WATCHER_FILE
      if (existsSync(filePath)) unlinkSync(filePath)
      if (existsSync(completedPath)) unlinkSync(completedPath)
    }
  })

  test("file watcher complete() then fetch() round-trip skips completed tasks", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/put-fetch-rt.ndjson"
    const completedPath = ".tmp/put-fetch-rt-completed.ndjson"
    writeFileSync(
      filePath,
      [
        JSON.stringify({ id: "1", title: "First" }),
        JSON.stringify({ id: "2", title: "Second" }),
        JSON.stringify({ id: "3", title: "Third" }),
      ].join("\n") + "\n"
    )

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
        dispatch: ".switchboard/commands/",
        pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })

      // Complete tasks 1 and 3
      const mockCtx = { summarize: async () => "", output: {} }
      await watcher.complete!({ id: "1", title: "First", description: null, url: null, priority: null }, mockCtx)
      await watcher.complete!({ id: "3", title: "Third", description: null, url: null, priority: null }, mockCtx)

      // Next fetch should only yield task 2
      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(1)
      expect(tasks[0].id).toBe("2")

      // Completed file should have both, in order
      const completed = readFileSync(completedPath, "utf-8")
      const completedLines = completed.split("\n").filter((l) => l.trim())
      expect(completedLines).toHaveLength(2)
      expect(JSON.parse(completedLines[0]).id).toBe("1")
      expect(JSON.parse(completedLines[1]).id).toBe("3")
    } finally {
      delete process.env.WATCHER_FILE
      if (existsSync(filePath)) unlinkSync(filePath)
      if (existsSync(completedPath)) unlinkSync(completedPath)
    }
  })

  test("file watcher complete() includes results metadata in completed file", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/put-results.ndjson"
    const completedPath = ".tmp/put-results-completed.ndjson"
    writeFileSync(filePath, JSON.stringify({ id: "r1", title: "With results" }) + "\n")

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
        dispatch: ".switchboard/commands/",
        pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })

      const mockContext = { summarize: async () => "summary", output: {} }

      await watcher.complete!({
        id: "r1",
        title: "With results",
        description: null,
        url: null,
        priority: null,
        results: {
          status: "complete",
          dispatchId: "d-123",
          logDir: "/tmp/logs/d-123",
          steps: [{ name: "init.sh", exitCode: 0 }],
        },
      }, mockContext)

      const completed = readFileSync(completedPath, "utf-8")
      const entry = JSON.parse(completed.trim())
      expect(entry.id).toBe("r1")
      expect(entry.results.status).toBe("complete")
      expect(entry.results.dispatchId).toBe("d-123")
      expect(entry.results.logDir).toBe("/tmp/logs/d-123")
      expect(entry.results.steps).toEqual([{ name: "init.sh", exitCode: 0 }])
    } finally {
      delete process.env.WATCHER_FILE
      if (existsSync(filePath)) unlinkSync(filePath)
      if (existsSync(completedPath)) unlinkSync(completedPath)
    }
  })

  test("file watcher uses WATCHER_FILE_COMPLETE when set", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/put-custom.ndjson"
    const customCompletedPath = ".tmp/custom-done.ndjson"
    const defaultCompletedPath = ".tmp/put-custom-completed.ndjson"
    writeFileSync(filePath, JSON.stringify({ id: "x", title: "Task X" }) + "\n")

    process.env.WATCHER_FILE = filePath
    process.env.WATCHER_FILE_COMPLETE = customCompletedPath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
        dispatch: ".switchboard/commands/",
        pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })

      await watcher.complete!({ id: "x", title: "Task X", description: null, url: null, priority: null }, { summarize: async () => "", output: {} })

      // Should write to the custom path, not the derived one
      expect(existsSync(customCompletedPath)).toBe(true)
      expect(existsSync(defaultCompletedPath)).toBe(false)

      const completed = readFileSync(customCompletedPath, "utf-8")
      expect(JSON.parse(completed.trim()).id).toBe("x")

      // fetch() should also read from the custom completed path
      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(0)
    } finally {
      delete process.env.WATCHER_FILE
      delete process.env.WATCHER_FILE_COMPLETE
      if (existsSync(filePath)) unlinkSync(filePath)
      if (existsSync(customCompletedPath)) unlinkSync(customCompletedPath)
      if (existsSync(defaultCompletedPath)) unlinkSync(defaultCompletedPath)
    }
  })

  test("file watcher fetch() yields all tasks when no completed file exists", async () => {
    mkdirSync(".tmp", { recursive: true })
    const filePath = ".tmp/no-completed.ndjson"
    const completedPath = ".tmp/no-completed-completed.ndjson"
    writeFileSync(
      filePath,
      [
        JSON.stringify({ id: "1", title: "One" }),
        JSON.stringify({ id: "2", title: "Two" }),
      ].join("\n") + "\n"
    )
    // Ensure no completed file exists
    if (existsSync(completedPath)) unlinkSync(completedPath)

    process.env.WATCHER_FILE = filePath
    try {
      const watcher = await resolveWatcher({
        watch: "file",
        agent: "test",
        dispatch: ".switchboard/commands/",
        pollInterval: 30_000,
        concurrency: 4,
        noTty: false,
      })

      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }
      expect(tasks).toHaveLength(2)
    } finally {
      delete process.env.WATCHER_FILE
      if (existsSync(filePath)) unlinkSync(filePath)
      if (existsSync(completedPath)) unlinkSync(completedPath)
    }
  })

  // -- Trackdown watcher (built-in) --

  test("built-in mode: resolves 'trackdown' and reads markdown cards from watch column", async () => {
    mkdirSync(".tmp", { recursive: true })
    const boardRoot = ".tmp/trackdown-board-fetch"
    const watchColumn = `${boardRoot}/todo`
    const doneColumn = `${boardRoot}/done`
    mkdirSync(watchColumn, { recursive: true })
    mkdirSync(doneColumn, { recursive: true })

    writeFileSync(`${watchColumn}/alpha.md`, "# Alpha\n\nDo alpha")
    writeFileSync(`${watchColumn}/beta.md`, "# Beta\n\nDo beta")
    writeFileSync(`${watchColumn}/ignore.txt`, "not a card")

    process.env.TRACKDOWN_ROOT = boardRoot
    process.env.TRACKDOWN_WATCH_COLUMN = "todo"
    process.env.TRACKDOWN_DONE_COLUMN = "done"

    try {
      const watcher = await resolveWatcher({
        watch: "trackdown",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        taskTtl: 60_000,
      })

      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }

      expect(tasks).toHaveLength(2)
      expect(tasks[0].title).toBe("alpha")
      expect(tasks[0].description).toContain("Do alpha")
      expect(tasks[0].id).toBe("alpha")
      expect(tasks[1].title).toBe("beta")
      expect(tasks[1].description).toContain("Do beta")
    } finally {
      delete process.env.TRACKDOWN_ROOT
      delete process.env.TRACKDOWN_WATCH_COLUMN
      delete process.env.TRACKDOWN_DONE_COLUMN
      if (existsSync(boardRoot)) rmSync(boardRoot, { recursive: true, force: true })
    }
  })

  test("trackdown watcher complete() moves completed cards to done column", async () => {
    mkdirSync(".tmp", { recursive: true })
    const boardRoot = ".tmp/trackdown-board-put"
    const watchColumn = `${boardRoot}/in-progress`
    const doneColumn = `${boardRoot}/done`
    mkdirSync(watchColumn, { recursive: true })

    const cardPath = `${watchColumn}/card-1.md`
    writeFileSync(cardPath, "# Card 1")

    process.env.TRACKDOWN_ROOT = boardRoot
    process.env.TRACKDOWN_WATCH_COLUMN = "in-progress"
    process.env.TRACKDOWN_DONE_COLUMN = "done"

    try {
      const watcher = await resolveWatcher({
        watch: "trackdown",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        taskTtl: 60_000,
      })

      await watcher.complete!(
        {
          id: "card-1",
          title: "card-1",
          description: null,
          url: null,
          priority: null,
          results: {
            status: "complete",
            dispatchId: "d1",
            logDir: "/tmp/d1",
            steps: [],
          },
        },
        { summarize: async () => "", output: {} },
      )

      expect(existsSync(cardPath)).toBe(false)
      expect(existsSync(`${doneColumn}/card-1.md`)).toBe(true)
    } finally {
      delete process.env.TRACKDOWN_ROOT
      delete process.env.TRACKDOWN_WATCH_COLUMN
      delete process.env.TRACKDOWN_DONE_COLUMN
      if (existsSync(boardRoot)) rmSync(boardRoot, { recursive: true, force: true })
    }
  })

  test("trackdown watcher complete() does not move cards when dispatch fails", async () => {
    mkdirSync(".tmp", { recursive: true })
    const boardRoot = ".tmp/trackdown-board-error"
    const watchColumn = `${boardRoot}/todo`
    mkdirSync(watchColumn, { recursive: true })

    const cardPath = `${watchColumn}/card-2.md`
    writeFileSync(cardPath, "# Card 2")

    process.env.TRACKDOWN_ROOT = boardRoot
    process.env.TRACKDOWN_WATCH_COLUMN = "todo"
    process.env.TRACKDOWN_DONE_COLUMN = "done"

    try {
      const watcher = await resolveWatcher({
        watch: "trackdown",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        taskTtl: 60_000,
      })

      await watcher.complete!(
        {
          id: "card-2",
          title: "card-2",
          description: null,
          url: null,
          priority: null,
          results: {
            status: "error",
            dispatchId: "d2",
            logDir: "/tmp/d2",
            steps: [],
          },
        },
        { summarize: async () => "", output: {} },
      )

      expect(existsSync(cardPath)).toBe(true)
      expect(existsSync(`${boardRoot}/done/card-2.md`)).toBe(false)
    } finally {
      delete process.env.TRACKDOWN_ROOT
      delete process.env.TRACKDOWN_WATCH_COLUMN
      delete process.env.TRACKDOWN_DONE_COLUMN
      if (existsSync(boardRoot)) rmSync(boardRoot, { recursive: true, force: true })
    }
  })

  test("trackdown watcher update() moves cards to active column when TRACKDOWN_ACTIVE_COLUMN is set", async () => {
    mkdirSync(".tmp", { recursive: true })
    const boardRoot = ".tmp/trackdown-board-active"
    const watchColumn = `${boardRoot}/todo`
    const activeColumn = `${boardRoot}/in-progress`
    mkdirSync(watchColumn, { recursive: true })

    const cardPath = `${watchColumn}/card-3.md`
    writeFileSync(cardPath, "# Card 3")

    process.env.TRACKDOWN_ROOT = boardRoot
    process.env.TRACKDOWN_WATCH_COLUMN = "todo"
    process.env.TRACKDOWN_DONE_COLUMN = "done"
    process.env.TRACKDOWN_ACTIVE_COLUMN = "in-progress"

    try {
      const watcher = await resolveWatcher({
        watch: "trackdown",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        taskTtl: 60_000,
      })

      const task: Task = {
        id: "card-3",
        title: "card-3",
        description: null,
        url: null,
        priority: null,
      }

      await watcher.update!(task, {
        dispatchId: "d3",
        logDir: "/tmp/logs/d3",
      })

      expect(existsSync(cardPath)).toBe(false)
      expect(existsSync(`${activeColumn}/card-3.md`)).toBe(true)
      expect(task.id).toBe("card-3")
      const updated = readFileSync(`${activeColumn}/card-3.md`, "utf-8")
      expect(updated.startsWith("---\nlogs: \"/tmp/logs/d3/*.log\"\n---\n")).toBe(true)
    } finally {
      delete process.env.TRACKDOWN_ROOT
      delete process.env.TRACKDOWN_WATCH_COLUMN
      delete process.env.TRACKDOWN_DONE_COLUMN
      delete process.env.TRACKDOWN_ACTIVE_COLUMN
      if (existsSync(boardRoot)) rmSync(boardRoot, { recursive: true, force: true })
    }
  })

  test("trackdown watcher update() is a no-op when TRACKDOWN_ACTIVE_COLUMN is unset", async () => {
    mkdirSync(".tmp", { recursive: true })
    const boardRoot = ".tmp/trackdown-board-active-unset"
    const watchColumn = `${boardRoot}/todo`
    mkdirSync(watchColumn, { recursive: true })

    const cardPath = `${watchColumn}/card-4.md`
    writeFileSync(cardPath, "# Card 4")

    process.env.TRACKDOWN_ROOT = boardRoot
    process.env.TRACKDOWN_WATCH_COLUMN = "todo"
    process.env.TRACKDOWN_DONE_COLUMN = "done"
    delete process.env.TRACKDOWN_ACTIVE_COLUMN

    try {
      const watcher = await resolveWatcher({
        watch: "trackdown",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        taskTtl: 60_000,
      })

      const task: Task = {
        id: "card-4",
        title: "card-4",
        description: null,
        url: null,
        priority: null,
      }

      await watcher.update?.(task, {
        dispatchId: "d4",
        logDir: "/tmp/logs/d4",
      })

      expect(existsSync(cardPath)).toBe(true)
      expect(task.id).toBe("card-4")
      const updated = readFileSync(cardPath, "utf-8")
      expect(updated.startsWith("---\nlogs: \"/tmp/logs/d4/*.log\"\n---\n")).toBe(true)
    } finally {
      delete process.env.TRACKDOWN_ROOT
      delete process.env.TRACKDOWN_WATCH_COLUMN
      delete process.env.TRACKDOWN_DONE_COLUMN
      delete process.env.TRACKDOWN_ACTIVE_COLUMN
      if (existsSync(boardRoot)) rmSync(boardRoot, { recursive: true, force: true })
    }
  })

  test("trackdown watcher update() replaces existing logs frontmatter", async () => {
    mkdirSync(".tmp", { recursive: true })
    const boardRoot = ".tmp/trackdown-board-frontmatter"
    const watchColumn = `${boardRoot}/todo`
    mkdirSync(watchColumn, { recursive: true })

    const cardPath = `${watchColumn}/card-5.md`
    writeFileSync(
      cardPath,
      "---\nstatus: open\nlogs: \"old/path\"\n---\n# Card 5\n",
    )

    process.env.TRACKDOWN_ROOT = boardRoot
    process.env.TRACKDOWN_WATCH_COLUMN = "todo"
    process.env.TRACKDOWN_DONE_COLUMN = "done"
    delete process.env.TRACKDOWN_ACTIVE_COLUMN

    try {
      const watcher = await resolveWatcher({
        watch: "trackdown",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        taskTtl: 60_000,
      })

      const task: Task = {
        id: "card-5",
        title: "card-5",
        description: null,
        url: null,
        priority: null,
      }

      await watcher.update?.(task, {
        dispatchId: "d5",
        logDir: "/tmp/logs/d5",
      })

      const updated = readFileSync(cardPath, "utf-8")
      expect(updated).toContain("status: open")
      expect(updated).toContain("logs: \"/tmp/logs/d5/*.log\"")
      expect(updated).not.toContain("logs: \"old/path\"")
    } finally {
      delete process.env.TRACKDOWN_ROOT
      delete process.env.TRACKDOWN_WATCH_COLUMN
      delete process.env.TRACKDOWN_DONE_COLUMN
      delete process.env.TRACKDOWN_ACTIVE_COLUMN
      if (existsSync(boardRoot)) rmSync(boardRoot, { recursive: true, force: true })
    }
  })
})
