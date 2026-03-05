import { describe, test, expect, mock } from "bun:test"
import { resolveWatcher } from "./watcher"
import type { Task } from "./types"
import { mkdirSync, writeFileSync, unlinkSync } from "fs"

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
      }`
    )

    const watcher = await resolveWatcher({
      watch: "./.tmp/watcher-dot-slash.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
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
      }`
    )

    const watcher = await resolveWatcher({
      watch: ".tmp/sub/watcher-slash.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
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
      }`
    )

    const watcher = await resolveWatcher({
      watch: "./.tmp/watcher-with-config.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 5_000,
      concurrency: 42,
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
    process.env.JIRA_JQL = "project = TEST"

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
      delete process.env.JIRA_JQL
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
        })
    } catch (e: any) {
      expect(e.message).toBe("process.exit called")
    } finally {
      console.error = originalError
      process.exit = originalExit
    }

    expect(exitCode).toBe(1)
    expect(errors.some((msg) => msg.includes('Unknown built-in watcher: "nonexistent"'))).toBe(true)
    expect(errors.some((msg) => msg.includes("Available: linear, github, jira, shell, file"))).toBe(true)
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
      }`
    )

    // Use a relative path with ".." -- we go from src/ up to project root then into .tmp/
    const watcher = await resolveWatcher({
      watch: "../switchboard/.tmp/watcher-parent.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      pollInterval: 30_000,
      concurrency: 4,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("parent-1")
  })
})
