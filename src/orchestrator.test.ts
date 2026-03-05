import { describe, test, expect, mock } from "bun:test"
import { createOrchestrator } from "./orchestrator"
import type { Dispatcher, DispatchHandle, Task, Watcher } from "./types"

// --- helpers ---

let fakePid = 90000

/** Dispatch that resolves instantly. */
const instantDispatch: Dispatcher = () => {
  return { pid: ++fakePid, done: Promise.resolve() }
}

/** Dispatch that never resolves (tasks stay in-flight for the test's lifetime). */
function hangingDispatch(): { dispatch: Dispatcher; resolve: () => void } {
  let resolver: () => void
  const gate = new Promise<void>((r) => { resolver = r })
  return {
    dispatch: () => ({ pid: ++fakePid, done: gate }),
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
    return { pid: ++fakePid, done }
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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

  test("respects concurrency limit", async () => {
    const { dispatch } = controllableDispatch()
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: String(i + 1), title: `Task ${i + 1}` })
    )
    const watcher = createMockWatcher(tasks)
    const orchestrator = createOrchestrator(
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 3 },
      watcher,
      dispatch
    )

    const stop = orchestrator.start()
    await new Promise((r) => setTimeout(r, 50))

    expect(orchestrator.inFlight.size).toBe(3)
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 50, concurrency: 10 },
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
    // Should have had at least 2 fetch calls (initial + after pollInterval)
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 2 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
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
      { watch: "test", agent: "test", dispatch: ".switchboard/commands/", pollInterval: 60_000, concurrency: 10 },
      watcher,
      instantDispatch
    )

    expect(orchestrator.inFlight).toBeInstanceOf(Set)
    expect(orchestrator.inFlight.size).toBe(0)
  })
})
