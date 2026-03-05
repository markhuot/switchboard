import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { parseDuration, parseArgs, formatElapsed } from "./config"
import createShellWatcher from "./watchers/shell"
import { resolveWatcher } from "./watcher"
import { createOrchestrator } from "./orchestrator"
import createJiraWatcher, {
  requireEnv,
  buildDescription,
  normalize,
} from "./watchers/jira"
import type { Task, Watcher, SwitchboardConfig, Dispatcher, StepResult } from "./types"
import os from "os"
import { mkdirSync, writeFileSync } from "fs"

// --- parseDuration ---

describe("parseDuration", () => {
  test("parses seconds suffix", () => {
    expect(parseDuration("3s")).toBe(3_000)
    expect(parseDuration("30s")).toBe(30_000)
  })

  test("parses minutes suffix", () => {
    expect(parseDuration("2m")).toBe(120_000)
    expect(parseDuration("1m")).toBe(60_000)
  })

  test("parses hours suffix", () => {
    expect(parseDuration("1h")).toBe(3_600_000)
    expect(parseDuration("2h")).toBe(7_200_000)
  })

  test("bare integer treated as seconds", () => {
    expect(parseDuration("10")).toBe(10_000)
    expect(parseDuration("60")).toBe(60_000)
  })
})

// --- formatElapsed ---

describe("formatElapsed", () => {
  test("returns 0s for sub-second durations", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(500)).toBe("0s")
    expect(formatElapsed(999)).toBe("0s")
  })

  test("formats seconds only", () => {
    expect(formatElapsed(1_000)).toBe("1s")
    expect(formatElapsed(45_000)).toBe("45s")
    expect(formatElapsed(59_000)).toBe("59s")
  })

  test("formats minutes and seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m")
    expect(formatElapsed(92_000)).toBe("1m 32s")
    expect(formatElapsed(5 * 60_000 + 3_000)).toBe("5m 3s")
  })

  test("formats hours and minutes", () => {
    expect(formatElapsed(3 * 3600_000 + 14 * 60_000)).toBe("3h 14m")
    expect(formatElapsed(3600_000)).toBe("1h")
  })

  test("formats days and hours", () => {
    expect(formatElapsed(2 * 86400_000 + 5 * 3600_000)).toBe("2d 5h")
    expect(formatElapsed(86400_000)).toBe("1d")
  })

  test("formats years and days", () => {
    expect(formatElapsed(4 * 365 * 86400_000 + 2 * 86400_000)).toBe("4y 2d")
    expect(formatElapsed(365 * 86400_000)).toBe("1y")
  })

  test("shows at most two units", () => {
    // 1 year, 2 days, 3 hours, 4 minutes, 5 seconds — should only show "1y 2d"
    const ms = (365 * 86400 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000
    expect(formatElapsed(ms)).toBe("1y 2d")
  })

  test("skips zero intermediate units", () => {
    // 1 hour and 5 seconds (0 minutes) — should show "1h" since second unit is s, not m
    // Actually: 3600 + 5 = 3605s. First unit: 1h (3600s used). Remaining: 5s.
    // Second qualifying unit: 5s. So "1h 5s"... wait, the algorithm checks remaining >= size.
    // remaining=5, m size=60, 5<60 so minutes skipped. s size=1, 5>=1 so "5s". Result: "1h 5s"
    expect(formatElapsed(3605_000)).toBe("1h 5s")
  })
})

// --- parseArgs ---

describe("parseArgs", () => {
  test("parses --watch flag", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode"])
    expect(config.watch).toBe("jira")
  })

  test("parses --agent flag", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=claude"])
    expect(config.agent).toBe("claude")
  })

  test("parses --dispatch flag", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode", "--dispatch=./my-pipeline/"])
    expect(config.dispatch).toBe("./my-pipeline/")
  })

  test("defaults dispatch to .switchboard/commands/", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode"])
    expect(config.dispatch).toBe(".switchboard/commands/")
  })

  test("parses --wait-between-polls flag", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode", "--wait-between-polls=5s"])
    expect(config.waitBetweenPolls).toBe(5_000)
  })

  test("parses --concurrency flag", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode", "--concurrency=10"])
    expect(config.concurrency).toBe(10)
  })

  test("defaults waitBetweenPolls to 30s", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode"])
    expect(config.waitBetweenPolls).toBe(30_000)
  })

  test("defaults concurrency to 2x CPU cores", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode"])
    expect(config.concurrency).toBe(2 * os.cpus().length)
  })

  test("parses shell mode --watch value", () => {
    const config = parseArgs(["bun", "script.ts", '--watch=$ echo "hello"', "--agent=opencode"])
    expect(config.watch).toBe('$ echo "hello"')
  })

  test("parses module mode --watch value", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=./my-watcher.ts", "--agent=opencode"])
    expect(config.watch).toBe("./my-watcher.ts")
  })

  test("parses --task-ttl flag", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode", "--task-ttl=30m"])
    expect(config.taskTtl).toBe(1_800_000)
  })

  test("defaults taskTtl to 1h", () => {
    const config = parseArgs(["bun", "script.ts", "--watch=jira", "--agent=opencode"])
    expect(config.taskTtl).toBe(3_600_000)
  })

})

// --- createShellWatcher ---

function shellConfig(command: string): SwitchboardConfig {
  return { watch: `$ ${command}`, agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 30_000, concurrency: 4, noTty: false }
}

describe("createShellWatcher", () => {
  test("parses JSON array from shell command", async () => {
    const watcher = createShellWatcher(
      shellConfig(`echo '[{"id":"1","title":"Task one"},{"id":"2","title":"Task two"}]'`)
    )
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(2)
    expect(tasks[0].id).toBe("1")
    expect(tasks[0].title).toBe("Task one")
    expect(tasks[1].id).toBe("2")
    expect(tasks[1].title).toBe("Task two")
  })

  test("parses NDJSON from shell command", async () => {
    const watcher = createShellWatcher(
      shellConfig(`printf '{"id":"1","title":"Task one"}\\n{"id":"2","title":"Task two"}'`)
    )
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(2)
    expect(tasks[0].id).toBe("1")
    expect(tasks[1].id).toBe("2")
  })

  test("fills in default values for optional fields", async () => {
    const watcher = createShellWatcher(
      shellConfig(`echo '[{"id":"1","title":"Minimal task"}]'`)
    )
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].identifier).toBeUndefined()
    expect(tasks[0].description).toBeNull()
    expect(tasks[0].url).toBeNull()
    expect(tasks[0].priority).toBeNull()
  })

  test("preserves optional fields when present", async () => {
    const watcher = createShellWatcher(
      shellConfig(`echo '[{"id":"1","title":"Full task","identifier":"PROJ-1","description":"A description","url":"https://example.com","priority":1}]'`)
    )
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks[0].identifier).toBe("PROJ-1")
    expect(tasks[0].description).toBe("A description")
    expect(tasks[0].url).toBe("https://example.com")
    expect(tasks[0].priority).toBe(1)
  })

  test("drops tasks missing id", async () => {
    const watcher = createShellWatcher(
      shellConfig(`echo '[{"title":"No id task"},{"id":"2","title":"Valid task"}]'`)
    )
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("2")
  })

  test("drops tasks missing title", async () => {
    const watcher = createShellWatcher(
      shellConfig(`echo '[{"id":"1"},{"id":"2","title":"Valid task"}]'`)
    )
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("2")
  })

  test("handles non-zero exit code gracefully", async () => {
    const watcher = createShellWatcher(shellConfig("exit 1"))
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(0)
  })

  test("handles invalid JSON gracefully", async () => {
    const watcher = createShellWatcher(shellConfig("echo 'not json'"))
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(0)
  })

  test("handles empty output gracefully", async () => {
    const watcher = createShellWatcher(shellConfig("echo ''"))
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(0)
  })

  test("strips $ prefix from watch config", async () => {
    const watcher = createShellWatcher({
      watch: `$ echo '[{"id":"1","title":"Prefixed"}]'`,
      agent: "test",
      dispatch: ".switchboard/commands/",
      waitBetweenPolls: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe("Prefixed")
  })
})

// --- resolveWatcher ---

describe("resolveWatcher", () => {
  test("shell mode: starts with '$ '", async () => {
    const watcher = await resolveWatcher({
      watch: '$ echo \'[{"id":"1","title":"Shell task"}]\'',
      agent: "test",
      dispatch: ".switchboard/commands/",
      waitBetweenPolls: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe("Shell task")
  })

  test("module mode: path with ./", async () => {
    // Create a temporary watcher module
    mkdirSync(".tmp", { recursive: true })
    writeFileSync(
      ".tmp/test-watcher.ts",
      `export default function createWatcher(config) {
        return {
          async *fetch() {
            yield { id: "mod-1", title: "Module task", description: null, url: null, priority: null }
          },
        }
      }`
    )

    const watcher = await resolveWatcher({
      watch: "./.tmp/test-watcher.ts",
      agent: "test",
      dispatch: ".switchboard/commands/",
      waitBetweenPolls: 30_000,
      concurrency: 4,
      noTty: false,
    })
    const tasks: Task[] = []
    for await (const task of watcher.fetch()) {
      tasks.push(task)
    }
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe("mod-1")
    expect(tasks[0].title).toBe("Module task")
  })

  test("built-in mode: resolves known name", async () => {
    // The jira watcher validates env vars at construction time
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
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        })
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
})

// --- orchestrator ---

describe("createOrchestrator", () => {
  let fakePid = 80000

  /** Dispatch that never resolves — tasks stay in-flight for the test's lifetime. */
  function controllableDispatch() {
    const resolvers = new Map<string, () => void>()
    const dispatch: Dispatcher = (task, dispatchId) => {
      const done = new Promise<StepResult[]>((resolve) => { resolvers.set(task.id, () => resolve([])) })
      return { pid: ++fakePid, dispatchId, logDir: "/tmp/test-logs", output: {}, done }
    }
    return {
      dispatch,
      complete(id: string) {
        const resolve = resolvers.get(id)
        if (resolve) { resolve(); resolvers.delete(id) }
      },
    }
  }

  const instantDispatch: Dispatcher = (_task, dispatchId) => ({ pid: ++fakePid, dispatchId, logDir: "/tmp/test-logs", output: {}, done: Promise.resolve([]) })

  function createMockWatcher(tasks: Task[]): Watcher {
    return {
      async *fetch() {
        yield* tasks
      },
    }
  }

  test("dispatches tasks from watcher", async () => {
    const { dispatch, complete } = controllableDispatch()
    const tasks: Task[] = [
      { id: "1", title: "Task 1", description: null, url: null, priority: null },
      { id: "2", title: "Task 2", description: null, url: null, priority: null },
    ]

    const watcher = createMockWatcher(tasks)
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(2)
    expect(orchestrator.inFlight.has("1")).toBe(true)
    expect(orchestrator.inFlight.has("2")).toBe(true)
    complete("1"); complete("2")
    stop()
  })

  test("respects concurrency limit", async () => {
    const { dispatch } = controllableDispatch()
    const tasks: Task[] = [
      { id: "1", title: "Task 1", description: null, url: null, priority: null },
      { id: "2", title: "Task 2", description: null, url: null, priority: null },
      { id: "3", title: "Task 3", description: null, url: null, priority: null },
      { id: "4", title: "Task 4", description: null, url: null, priority: null },
    ]

    const watcher = createMockWatcher(tasks)
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 2, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(2)
    stop()
  })

  test("fills remaining slots when tasks complete", async () => {
    const { dispatch, complete } = controllableDispatch()
    const tasks: Task[] = [
      { id: "1", title: "Task 1", description: null, url: null, priority: null },
      { id: "2", title: "Task 2", description: null, url: null, priority: null },
      { id: "3", title: "Task 3", description: null, url: null, priority: null },
    ]

    const watcher = createMockWatcher(tasks)
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 2, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(2)
    expect(orchestrator.inFlight.has("1")).toBe(true)
    expect(orchestrator.inFlight.has("2")).toBe(true)

    // Complete task 1 — frees a slot for task 3
    complete("1")
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.has("1")).toBe(false)
    expect(orchestrator.inFlight.has("3")).toBe(true)
    expect(orchestrator.inFlight.size).toBe(2) // tasks 2 and 3

    complete("2"); complete("3")
    stop()
  })

  test("skips duplicate task IDs", async () => {
    const { dispatch, complete } = controllableDispatch()
    const watcher: Watcher = {
      async *fetch() {
        yield { id: "1", title: "Task 1", description: null, url: null, priority: null }
        yield { id: "1", title: "Task 1 duplicate", description: null, url: null, priority: null }
        yield { id: "2", title: "Task 2", description: null, url: null, priority: null }
      },
    }

    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(2)
    complete("1"); complete("2")
    stop()
  })
})

// --- Jira watcher: requireEnv ---

describe("requireEnv", () => {
  test("returns value when env var is set", () => {
    process.env.TEST_REQUIRE_ENV = "hello"
    expect(requireEnv("TEST_REQUIRE_ENV")).toBe("hello")
    delete process.env.TEST_REQUIRE_ENV
  })

  test("throws when env var is missing", () => {
    delete process.env.TEST_MISSING_VAR
    expect(() => requireEnv("TEST_MISSING_VAR")).toThrow(
      "Missing required environment variable: TEST_MISSING_VAR"
    )
  })

  test("throws when env var is empty string", () => {
    process.env.TEST_EMPTY_VAR = ""
    expect(() => requireEnv("TEST_EMPTY_VAR")).toThrow(
      "Missing required environment variable: TEST_EMPTY_VAR"
    )
    delete process.env.TEST_EMPTY_VAR
  })
})

// --- Jira watcher: buildDescription ---

describe("buildDescription", () => {
  test("returns description only when no comments", () => {
    const result = buildDescription("Issue body text", [])
    expect(result).toBe("Issue body text")
  })

  test("returns null when no description and no comments", () => {
    const result = buildDescription(null, [])
    expect(result).toBeNull()
  })

  test("returns comments only when description is null", () => {
    const result = buildDescription(null, [
      {
        author: { name: "jsmith", displayName: "John Smith" },
        body: "A comment",
        created: "2018-01-15T10:30:00.000+0000",
      },
    ])
    expect(result).toBe(
      '<comments>\n<comment author="John Smith">\nA comment\n</comment>\n</comments>'
    )
  })

  test("appends comments after description", () => {
    const result = buildDescription("Issue body", [
      {
        author: { name: "jsmith", displayName: "John Smith" },
        body: "First comment",
        created: "2018-01-15T10:30:00.000+0000",
      },
      {
        author: { name: "mjones", displayName: "Mary Jones" },
        body: "Second comment",
        created: "2018-01-16T14:22:00.000+0000",
      },
    ])
    expect(result).toBe(
      'Issue body\n\n<comments>\n<comment author="John Smith">\nFirst comment\n</comment>\n<comment author="Mary Jones">\nSecond comment\n</comment>\n</comments>'
    )
  })

  test("falls back to author.name when displayName is missing", () => {
    const result = buildDescription(null, [
      {
        author: { name: "jsmith", displayName: undefined as any },
        body: "A comment",
        created: "2018-01-15T10:30:00.000+0000",
      },
    ])
    expect(result).toContain('author="jsmith"')
  })

  test("uses 'Unknown' when author is missing", () => {
    const result = buildDescription(null, [
      {
        author: undefined as any,
        body: "A comment",
        created: "2018-01-15T10:30:00.000+0000",
      },
    ])
    expect(result).toContain('author="Unknown"')
  })
})

// --- Jira watcher: normalize ---

describe("normalize", () => {
  const baseIssue = {
    id: "10001",
    self: "https://jira.example.com/rest/api/2/issue/10001",
    key: "PROJ-123",
    fields: {
      summary: "Fix login timeout",
      description: "The login form times out on slow connections",
      priority: {
        self: "https://jira.example.com/rest/api/2/priority/3",
        id: "3",
        name: "Major",
        iconUrl: "https://jira.example.com/images/icons/priorities/major.svg",
      },
      comment: {
        comments: [
          {
            author: { name: "jsmith", displayName: "John Smith" },
            body: "I can reproduce this.",
            created: "2018-01-15T10:30:00.000+0000",
          },
        ],
        maxResults: 20,
        total: 1,
        startAt: 0,
      },
    },
  }

  test("maps all fields correctly", () => {
    const task = normalize(baseIssue, "https://jira.example.com")
    expect(task.id).toBe("10001")
    expect(task.identifier).toBe("PROJ-123")
    expect(task.title).toBe("Fix login timeout")
    expect(task.url).toBe("https://jira.example.com/browse/PROJ-123")
    expect(task.priority).toBe(3)
  })

  test("includes description and comments in description field", () => {
    const task = normalize(baseIssue, "https://jira.example.com")
    expect(task.description).toContain("The login form times out on slow connections")
    expect(task.description).toContain("I can reproduce this.")
    expect(task.description).toContain('<comment author="John Smith">')
  })

  test("handles null priority", () => {
    const issue = {
      ...baseIssue,
      fields: { ...baseIssue.fields, priority: null },
    }
    const task = normalize(issue, "https://jira.example.com")
    expect(task.priority).toBeNull()
  })

  test("handles null description with no comments", () => {
    const issue = {
      ...baseIssue,
      fields: {
        ...baseIssue.fields,
        description: null,
        comment: { comments: [], maxResults: 20, total: 0, startAt: 0 },
      },
    }
    const task = normalize(issue, "https://jira.example.com")
    expect(task.description).toBeNull()
  })

  test("parses priority id to integer", () => {
    const task = normalize(baseIssue, "https://jira.example.com")
    expect(typeof task.priority).toBe("number")
    expect(task.priority).toBe(3)
  })
})

// --- Jira watcher: createWatcher ---

describe("createJiraWatcher", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ["JIRA_BASE_URL", "JIRA_TOKEN", "JIRA_JQL"]) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  test("throws when JIRA_BASE_URL is missing", () => {
    delete process.env.JIRA_BASE_URL
    process.env.JIRA_TOKEN = "test-token"
    process.env.JIRA_JQL = "project = TEST"

    expect(() =>
      createJiraWatcher({ watch: "jira", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 30_000, concurrency: 4, noTty: false })
    ).toThrow("Missing required environment variable: JIRA_BASE_URL")
  })

  test("throws when JIRA_TOKEN is missing", () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    delete process.env.JIRA_TOKEN
    process.env.JIRA_JQL = "project = TEST"

    expect(() =>
      createJiraWatcher({ watch: "jira", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 30_000, concurrency: 4, noTty: false })
    ).toThrow("Missing required environment variable: JIRA_TOKEN")
  })

  test("throws when JIRA_JQL is missing", () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "test-token"
    delete process.env.JIRA_JQL

    expect(() =>
      createJiraWatcher({ watch: "jira", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 30_000, concurrency: 4, noTty: false })
    ).toThrow("Missing required environment variable: JIRA_JQL")
  })

  test("creates watcher successfully when all env vars are set", () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "test-token"
    process.env.JIRA_JQL = "project = TEST"

    const watcher = createJiraWatcher({
      watch: "jira",
      agent: "test",
      dispatch: ".switchboard/commands/",
      waitBetweenPolls: 30_000,
      concurrency: 4,
      noTty: false,
    })
    expect(watcher).toBeDefined()
    expect(typeof watcher.fetch).toBe("function")
  })

  test("fetch yields tasks from a single page", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "test-token"
    process.env.JIRA_JQL = "project = TEST"

    const mockResponse = {
      startAt: 0,
      maxResults: 10,
      total: 2,
      issues: [
        {
          id: "10001",
          self: "https://jira.example.com/rest/api/2/issue/10001",
          key: "TEST-1",
          fields: {
            summary: "First issue",
            description: "Description one",
            priority: { self: "", id: "1", name: "Highest", iconUrl: "" },
            comment: { comments: [], maxResults: 20, total: 0, startAt: 0 },
          },
        },
        {
          id: "10002",
          self: "https://jira.example.com/rest/api/2/issue/10002",
          key: "TEST-2",
          fields: {
            summary: "Second issue",
            description: null,
            priority: { self: "", id: "3", name: "Medium", iconUrl: "" },
            comment: {
              comments: [
                {
                  author: { name: "dev", displayName: "Dev User" },
                  body: "Working on this",
                  created: "2024-01-01T00:00:00.000+0000",
                },
              ],
              maxResults: 20,
              total: 1,
              startAt: 0,
            },
          },
        },
      ],
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as any

    try {
      const watcher = createJiraWatcher({
        watch: "jira",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        })

      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }

      expect(tasks).toHaveLength(2)
      expect(tasks[0].id).toBe("10001")
      expect(tasks[0].identifier).toBe("TEST-1")
      expect(tasks[0].title).toBe("First issue")
      expect(tasks[0].description).toBe("Description one")
      expect(tasks[0].url).toBe("https://jira.example.com/browse/TEST-1")
      expect(tasks[0].priority).toBe(1)

      expect(tasks[1].id).toBe("10002")
      expect(tasks[1].identifier).toBe("TEST-2")
      expect(tasks[1].description).toContain("Working on this")
      expect(tasks[1].priority).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fetch paginates through multiple pages", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "test-token"
    process.env.JIRA_JQL = "project = TEST"

    const page1 = {
      startAt: 0,
      maxResults: 10,
      total: 12,
      issues: Array.from({ length: 10 }, (_, i) => ({
        id: String(i + 1),
        self: `https://jira.example.com/rest/api/2/issue/${i + 1}`,
        key: `TEST-${i + 1}`,
        fields: {
          summary: `Issue ${i + 1}`,
          description: null,
          priority: null,
          comment: { comments: [], maxResults: 20, total: 0, startAt: 0 },
        },
      })),
    }

    const page2 = {
      startAt: 10,
      maxResults: 10,
      total: 12,
      issues: Array.from({ length: 2 }, (_, i) => ({
        id: String(i + 11),
        self: `https://jira.example.com/rest/api/2/issue/${i + 11}`,
        key: `TEST-${i + 11}`,
        fields: {
          summary: `Issue ${i + 11}`,
          description: null,
          priority: null,
          comment: { comments: [], maxResults: 20, total: 0, startAt: 0 },
        },
      })),
    }

    let callCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      callCount++
      const body = callCount === 1 ? page1 : page2
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    try {
      const watcher = createJiraWatcher({
        watch: "jira",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 20,
        noTty: false,
        })

      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }

      expect(tasks).toHaveLength(12)
      expect(callCount).toBe(2)
      expect(tasks[0].id).toBe("1")
      expect(tasks[11].id).toBe("12")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fetch throws on non-200 response", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "test-token"
    process.env.JIRA_JQL = "project = TEST"

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })
    ) as any

    try {
      const watcher = createJiraWatcher({
        watch: "jira",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        })

      const tasks: Task[] = []
      await expect(async () => {
        for await (const task of watcher.fetch()) {
          tasks.push(task)
        }
      }).toThrow("Jira search failed: 401 Unauthorized")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fetch stops when issues array is empty", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "test-token"
    process.env.JIRA_JQL = "project = TEST"

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          startAt: 0,
          maxResults: 10,
          total: 0,
          issues: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as any

    try {
      const watcher = createJiraWatcher({
        watch: "jira",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        })

      const tasks: Task[] = []
      for await (const task of watcher.fetch()) {
        tasks.push(task)
      }

      expect(tasks).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fetch sends correct auth header and request body", async () => {
    process.env.JIRA_BASE_URL = "https://jira.example.com"
    process.env.JIRA_TOKEN = "my-secret-token"
    process.env.JIRA_JQL = "project = MYPROJ ORDER BY priority ASC"

    let capturedUrl: string = ""
    let capturedInit: any = {}

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: string, init: any) => {
      capturedUrl = url
      capturedInit = init
      return new Response(
        JSON.stringify({
          startAt: 0,
          maxResults: 10,
          total: 0,
          issues: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }) as any

    try {
      const watcher = createJiraWatcher({
        watch: "jira",
        agent: "test",
        dispatch: ".switchboard/commands/",
        waitBetweenPolls: 30_000,
        concurrency: 4,
        noTty: false,
        })

      for await (const _ of watcher.fetch()) {
        // consume generator
      }

      expect(capturedUrl).toBe("https://jira.example.com/rest/api/2/search")
      expect(capturedInit.method).toBe("POST")

      expect(capturedInit.headers.Authorization).toBe("Bearer my-secret-token")
      expect(capturedInit.headers["Content-Type"]).toBe("application/json")

      const body = JSON.parse(capturedInit.body)
      expect(body.jql).toBe("project = MYPROJ ORDER BY priority ASC")
      expect(body.startAt).toBe(0)
      expect(body.maxResults).toBe(10)
      expect(body.fields).toEqual(["summary", "description", "priority", "comment"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
