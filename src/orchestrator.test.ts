import { describe, test, expect, mock } from "bun:test"
import { createOrchestrator } from "./orchestrator"
import type { Dispatcher, DispatchHandle, LockStore, StepResult, Task, PutContext, Watcher } from "./types"

// --- helpers ---

let fakePid = 90000

/** Dispatch that resolves instantly. */
const instantDispatch: Dispatcher = () => {
  return { pid: ++fakePid, done: Promise.resolve(), output: {} }
}

/** Dispatch that never resolves (tasks stay in-flight for the test's lifetime). */
function hangingDispatch(): { dispatch: Dispatcher; resolve: () => void } {
  let resolver: () => void
  const gate = new Promise<void>((r) => { resolver = r })
  return {
    dispatch: () => ({ pid: ++fakePid, done: gate, output: {} }),
    resolve: () => resolver(),
  }
}

/**
 * Dispatch that captures calls and lets the test resolve them individually.
 */
function controllableDispatch() {
  const resolvers: Map<string, () => void> = new Map()

  const dispatch: Dispatcher = (task) => {
    const done = new Promise<void>((resolve) => {
      resolvers.set(task.id, resolve)
    })
    return { pid: ++fakePid, done, output: {} }
  }

  return {
    dispatch,
    /** Resolve a specific task's dispatch. */
    complete(id: string) {
      const resolve = resolvers.get(id)
      if (resolve) {
        resolve()
        resolvers.delete(id)
      }
    },
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    title: "Task 1",
    description: null,
    url: null,
    priority: null,
    ...overrides,
  }
}

function createMockWatcher(tasks: Task[]): Watcher {
  return {
    async *fetch() {
      yield* tasks
    },
  }
}

// --- createOrchestrator ---

describe("createOrchestrator", () => {
  test("dispatches tasks from watcher", async () => {
    const { dispatch, complete } = controllableDispatch()
    const tasks = [makeTask({ id: "1" }), makeTask({ id: "2", title: "Task 2" })]
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

    complete("1")
    complete("2")
    stop()
  })

  test("passes handle.output to put() via context.output", async () => {
    const resolvers = new Map<string, (steps: StepResult[]) => void>()
    let fakePid = 80000

    const dispatch: Dispatcher = (task) => {
      const dispatchId = `test-${task.id}`
      const logDir = `/tmp/test-logs/${task.id}`
      const done = new Promise<StepResult[]>((resolve) => {
        resolvers.set(task.id, resolve)
      })
      // Pre-populate output as if directives were collected during lifecycle
      const output = { pr_url: "https://github.com/org/repo/pull/42", custom: "value" }
      return { pid: ++fakePid, dispatchId, logDir, done, output }
    }

    const putContexts: PutContext[] = []
    const watcher: Watcher = {
      async *fetch() {
        yield makeTask({ id: "out1", title: "Output task" })
      },
      async put(_task, context) {
        putContexts.push(context)
      },
    }
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    const resolve = resolvers.get("out1")
    if (resolve) resolve([])
    await new Promise((r) => setTimeout(r, 50))

    expect(putContexts).toHaveLength(1)
    expect(putContexts[0].output).toEqual({
      pr_url: "https://github.com/org/repo/pull/42",
      custom: "value",
    })

    stop()
  })

  test("skips duplicate task IDs", async () => {
    const { dispatch, complete } = controllableDispatch()
    const watcher: Watcher = {
      async *fetch() {
        yield makeTask({ id: "1", title: "First" })
        yield makeTask({ id: "1", title: "Duplicate" })
        yield makeTask({ id: "2", title: "Second" })
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
    expect(orchestrator.inFlight.has("1")).toBe(true)
    expect(orchestrator.inFlight.has("2")).toBe(true)

    complete("1")
    complete("2")
    stop()
  })

  test("start returns a cleanup function that stops the loop", async () => {
    let fetchCount = 0
    const watcher: Watcher = {
      async *fetch() {
        fetchCount++
      },
    }

    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 50, concurrency: 10, noTty: false },
      watcher,
      instantDispatch
    )

    const stop = orchestrator.start()
    // Let the loop exhaust the generator and wait a poll cycle
    await new Promise((r) => setTimeout(r, 130))
    stop()

    const countAfterStop = fetchCount
    // Wait to ensure no more fetch calls fire
    await new Promise((r) => setTimeout(r, 150))

    expect(fetchCount).toBe(countAfterStop)
    // Should have had at least 2 fetch calls (initial + after waitBetweenPolls)
    expect(countAfterStop).toBeGreaterThanOrEqual(2)
  })

  test("drops tasks with missing id", async () => {
    const { dispatch, complete } = controllableDispatch()
    const watcher: Watcher = {
      async *fetch() {
        yield { id: "", title: "No id", description: null, url: null, priority: null } as Task
        yield makeTask({ id: "valid", title: "Valid" })
      },
    }

    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(1)
    expect(orchestrator.inFlight.has("valid")).toBe(true)

    complete("valid")
    stop()
  })

  test("drops tasks with missing title", async () => {
    const { dispatch, complete } = controllableDispatch()
    const watcher: Watcher = {
      async *fetch() {
        yield { id: "1", title: "", description: null, url: null, priority: null } as Task
        yield makeTask({ id: "valid", title: "Valid" })
      },
    }

    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(1)
    expect(orchestrator.inFlight.has("valid")).toBe(true)

    complete("valid")
    stop()
  })

  test("handles watcher.fetch() throwing gracefully", async () => {
    const watcher: Watcher = {
      async *fetch() {
        throw new Error("fetch exploded")
      },
    }

    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      instantDispatch
    )

    // Should not throw -- the error is caught internally
    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(0)
    stop()
  })

  test("removes tasks from inFlight after dispatch completes", async () => {
    const watcher = createMockWatcher([makeTask({ id: "1" })])
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      instantDispatch
    )

    const stop = orchestrator.start()
    // instant dispatch — give microtasks time to flush
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.has("1")).toBe(false)
    expect(orchestrator.inFlight.size).toBe(0)
    stop()
  })

  test("fills remaining slots when tasks complete", async () => {
    const { dispatch, complete } = controllableDispatch()
    const tasks = [
      makeTask({ id: "1" }),
      makeTask({ id: "2", title: "Task 2" }),
      makeTask({ id: "3", title: "Task 3" }),
    ]
    const watcher = createMockWatcher(tasks)
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 2, noTty: false },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    // First 2 dispatched, task 3 waiting for a slot
    expect(orchestrator.inFlight.has("1")).toBe(true)
    expect(orchestrator.inFlight.has("2")).toBe(true)
    expect(orchestrator.inFlight.size).toBe(2)

    // Complete task 1 — frees a slot for task 3
    complete("1")
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.has("1")).toBe(false)
    expect(orchestrator.inFlight.has("3")).toBe(true)
    expect(orchestrator.inFlight.size).toBe(2) // tasks 2 and 3

    complete("2")
    complete("3")
    stop()
  })

  test("emits in_progress event when task is dispatched", async () => {
    const events: { id: string; status: string }[] = []
    const { dispatch, complete } = controllableDispatch()

    const watcher = createMockWatcher([
      makeTask({ id: "123", identifier: "PROJ-123", title: "Identified task" }),
    ])
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      dispatch
    )

    orchestrator.onTaskEvent((event) => {
      events.push({ id: event.task.id, status: event.status })
    })

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(events).toHaveLength(1)
    expect(events[0].id).toBe("123")
    expect(events[0].status).toBe("in_progress")

    complete("123")
    stop()
  })

  test("emits complete event when dispatch finishes", async () => {
    const events: { id: string; status: string }[] = []

    const watcher = createMockWatcher([makeTask({ id: "1" })])
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      instantDispatch
    )

    orchestrator.onTaskEvent((event) => {
      events.push({ id: event.task.id, status: event.status })
    })

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(events).toHaveLength(2)
    expect(events[0].status).toBe("in_progress")
    expect(events[1].status).toBe("complete")

    stop()
  })

  test("silently drops malformed tasks", async () => {
    const events: { id: string; status: string }[] = []
    const { dispatch, complete } = controllableDispatch()

    const watcher: Watcher = {
      async *fetch() {
        yield { id: "", title: "", description: null, url: null, priority: null } as Task
        yield makeTask({ id: "valid", title: "Valid" })
      },
    }

    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      dispatch
    )

    orchestrator.onTaskEvent((event) => {
      events.push({ id: event.task.id, status: event.status })
    })

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    // Only the valid task should emit
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe("valid")

    complete("valid")
    stop()
  })

  test("handles watcher.fetch() throwing without emitting events", async () => {
    const events: { id: string; status: string }[] = []

    const watcher: Watcher = {
      async *fetch() {
        throw new Error("boom")
      },
    }

    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      instantDispatch
    )

    orchestrator.onTaskEvent((event) => {
      events.push({ id: event.task.id, status: event.status })
    })

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(events).toHaveLength(0)
    expect(orchestrator.inFlight.size).toBe(0)

    stop()
  })

  test("inFlight set is exposed on return object", () => {
    const watcher = createMockWatcher([])
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", waitBetweenPolls: 60_000, concurrency: 10, noTty: false },
      watcher,
      instantDispatch
    )

    expect(orchestrator.inFlight).toBeInstanceOf(Set)
    expect(orchestrator.inFlight.size).toBe(0)
  })
})

// --- new helpers for lock store / writeback tests ---

const defaultConfig = {
  watch: "test",
  agent: "test",
  dispatch: ".switchboard/commands/",
  waitBetweenPolls: 60_000,
  taskTtl: 3_600_000,
  concurrency: 10,
  noTty: false,
}

function newControllableDispatch() {
  const resolvers = new Map<string, (steps: StepResult[]) => void>()
  const rejecters = new Map<string, (err: Error) => void>()
  let fakePid = 70000

  const dispatch: Dispatcher = (task) => {
    const dispatchId = `test-${task.id}`
    const logDir = `/tmp/test-logs/${task.id}`
    const done = new Promise<StepResult[]>((resolve, reject) => {
      resolvers.set(task.id, resolve)
      rejecters.set(task.id, reject)
    })
    return { pid: ++fakePid, dispatchId, logDir, done, output: {} }
  }

  return {
    dispatch,
    complete(id: string, steps: StepResult[] = []) {
      const resolve = resolvers.get(id)
      if (resolve) { resolve(steps); resolvers.delete(id); rejecters.delete(id) }
    },
    fail(id: string, err = new Error("dispatch failed")) {
      const reject = rejecters.get(id)
      if (reject) { reject(err); rejecters.delete(id); resolvers.delete(id) }
    },
  }
}

function newInstantDispatch(): Dispatcher {
  let fakePid = 60000
  return (task) => ({
    pid: ++fakePid,
    dispatchId: `instant-${task.id}`,
    logDir: `/tmp/test-logs/${task.id}`,
    done: Promise.resolve([]),
    output: {},
  })
}

function createMockLockStore(
  acquireResult: boolean | Error = true,
): LockStore & {
  acquireCalls: Array<{ taskId: string; meta: { dispatchId: string } }>
  releaseCalls: string[]
} {
  const acquireCalls: Array<{ taskId: string; meta: { dispatchId: string } }> = []
  const releaseCalls: string[] = []
  return {
    acquireCalls,
    releaseCalls,
    async acquire(taskId, meta) {
      acquireCalls.push({ taskId, meta })
      if (acquireResult instanceof Error) throw acquireResult
      return acquireResult
    },
    async release(taskId) {
      releaseCalls.push(taskId)
    },
  }
}

// --- lock store tests ---

describe("createOrchestrator lock store", () => {
  test("skips task when lock store returns false", async () => {
    const { dispatch, complete } = newControllableDispatch()
    const lockStore = createMockLockStore(false)
    const watcher = createMockWatcher([makeTask({ id: "1" })])
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch, lockStore)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(0)
    expect(lockStore.acquireCalls).toHaveLength(1)

    stop()
  })

  test("acquires lock with correct dispatchId", async () => {
    const { dispatch, complete } = newControllableDispatch()
    const lockStore = createMockLockStore(true)
    const watcher = createMockWatcher([makeTask({ id: "abc" })])
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch, lockStore)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(lockStore.acquireCalls).toHaveLength(1)
    expect(lockStore.acquireCalls[0].taskId).toBe("abc")
    expect(lockStore.acquireCalls[0].meta.dispatchId).toBe("test-abc")

    complete("abc")
    stop()
  })

  test("releases lock after dispatch completes", async () => {
    const { dispatch, complete } = newControllableDispatch()
    const lockStore = createMockLockStore(true)
    const watcher = createMockWatcher([makeTask({ id: "1" })])
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch, lockStore)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.has("1")).toBe(true)
    expect(lockStore.releaseCalls).toHaveLength(0)

    complete("1")
    await new Promise((r) => setTimeout(r, 50))

    expect(lockStore.releaseCalls).toHaveLength(1)
    expect(lockStore.releaseCalls[0]).toBe("1")
    expect(orchestrator.inFlight.has("1")).toBe(false)

    stop()
  })

  test("releases lock after dispatch fails", async () => {
    const { dispatch, fail } = newControllableDispatch()
    const lockStore = createMockLockStore(true)
    const watcher = createMockWatcher([makeTask({ id: "1" })])
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch, lockStore)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.has("1")).toBe(true)

    fail("1")
    await new Promise((r) => setTimeout(r, 50))

    expect(lockStore.releaseCalls).toHaveLength(1)
    expect(lockStore.releaseCalls[0]).toBe("1")
    expect(orchestrator.inFlight.has("1")).toBe(false)

    stop()
  })

  test("skips task when lock store acquire throws", async () => {
    const { dispatch } = newControllableDispatch()
    const lockStore = createMockLockStore(new Error("lock store unavailable"))
    const watcher = createMockWatcher([makeTask({ id: "1" })])
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch, lockStore)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(0)
    expect(lockStore.acquireCalls).toHaveLength(1)

    stop()
  })

  test("works without lock store (backward compat)", async () => {
    const { dispatch, complete } = newControllableDispatch()
    const watcher = createMockWatcher([makeTask({ id: "1" })])
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(1)
    expect(orchestrator.inFlight.has("1")).toBe(true)

    complete("1")
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(0)

    stop()
  })
})

// --- writeback tests ---

describe("createOrchestrator writeback", () => {
  test("calls watcher.put() after successful dispatch", async () => {
    const { dispatch, complete } = newControllableDispatch()
    const putCalls: Task[] = []
    const watcher: Watcher = {
      async *fetch() {
        yield makeTask({ id: "wb1", title: "Writeback task" })
      },
      async put(task, _context) {
        putCalls.push(task)
      },
    }
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    complete("wb1", [{ name: "init.sh", exitCode: 0 }])
    await new Promise((r) => setTimeout(r, 50))

    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].id).toBe("wb1")
    expect(putCalls[0].results).toBeDefined()
    expect(putCalls[0].results!.status).toBe("complete")
    expect(putCalls[0].results!.dispatchId).toBe("test-wb1")
    expect(putCalls[0].results!.logDir).toBe("/tmp/test-logs/wb1")
    expect(putCalls[0].results!.steps).toEqual([{ name: "init.sh", exitCode: 0 }])

    stop()
  })

  test("calls watcher.put() after failed dispatch", async () => {
    const { dispatch, fail } = newControllableDispatch()
    const putCalls: Task[] = []
    const watcher: Watcher = {
      async *fetch() {
        yield makeTask({ id: "fail1", title: "Failing task" })
      },
      async put(task, _context) {
        putCalls.push(task)
      },
    }
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    fail("fail1")
    await new Promise((r) => setTimeout(r, 50))

    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].id).toBe("fail1")
    expect(putCalls[0].results).toBeDefined()
    expect(putCalls[0].results!.status).toBe("error")
    expect(putCalls[0].results!.dispatchId).toBe("test-fail1")
    expect(putCalls[0].results!.logDir).toBe("/tmp/test-logs/fail1")
    expect(putCalls[0].results!.steps).toEqual([])

    stop()
  })

  test("does not call put() when watcher lacks put method", async () => {
    const dispatch = newInstantDispatch()
    const watcher: Watcher = {
      async *fetch() {
        yield makeTask({ id: "noput1", title: "No put" })
      },
      // no put method
    }
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    // Should complete without errors
    expect(orchestrator.inFlight.size).toBe(0)

    stop()
  })

  test("handles put() throwing gracefully", async () => {
    const { dispatch, complete } = newControllableDispatch()
    const lockStore = createMockLockStore(true)
    const watcher: Watcher = {
      async *fetch() {
        yield makeTask({ id: "throw1", title: "Throwing put" })
      },
      async put(_task, _context) {
        throw new Error("put exploded")
      },
    }
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch, lockStore)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    complete("throw1")
    await new Promise((r) => setTimeout(r, 50))

    // Orchestrator should not crash; lock should still be released
    expect(orchestrator.inFlight.has("throw1")).toBe(false)
    expect(lockStore.releaseCalls).toHaveLength(1)
    expect(lockStore.releaseCalls[0]).toBe("throw1")

    stop()
  })

  test("task.results includes steps from dispatch", async () => {
    const { dispatch, complete } = newControllableDispatch()
    const putCalls: Task[] = []
    const watcher: Watcher = {
      async *fetch() {
        yield makeTask({ id: "steps1", title: "Steps task" })
      },
      async put(task, _context) {
        putCalls.push(task)
      },
    }
    const orchestrator = createOrchestrator(defaultConfig, watcher, dispatch)

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    const steps: StepResult[] = [
      { name: "init.sh", exitCode: 0 },
      { name: "work.md", exitCode: 0 },
      { name: "cleanup.sh", exitCode: 1 },
    ]
    complete("steps1", steps)
    await new Promise((r) => setTimeout(r, 50))

    expect(putCalls).toHaveLength(1)
    expect(putCalls[0].results).toBeDefined()
    expect(putCalls[0].results!.steps).toEqual(steps)

    stop()
  })
})
