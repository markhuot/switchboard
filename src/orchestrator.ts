import type { Dispatcher, SwitchboardConfig, Task, Watcher } from "./types"

export type TaskStatus = "in_progress" | "complete" | "error"

export interface TaskEvent {
  task: Task
  status: TaskStatus
  /** PID of the spawned subprocess (set once dispatch resolves). */
  pid?: number
}

export type TaskListener = (event: TaskEvent) => void

/**
 * Create the orchestrator that continuously pulls tasks from a watcher,
 * dispatches them up to the concurrency limit, and waits for a slot
 * to open before pulling the next task.
 *
 * When the generator is exhausted the orchestrator waits pollInterval
 * then calls fetch() again for a fresh pass.
 */
export function createOrchestrator(
  config: SwitchboardConfig,
  watcher: Watcher,
  dispatch: Dispatcher,
) {
  const inFlight = new Set<string>()
  const listeners = new Set<TaskListener>()
  let stopped = false

  // Resolvers waiting for a concurrency slot to open
  let slotOpen: (() => void) | null = null

  // Resolver + timer for the poll-interval sleep so stop() can cancel it
  let pollResolve: (() => void) | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  function emit(task: Task, status: TaskStatus, pid?: number) {
    const event: TaskEvent = { task, status, pid }
    for (const listener of listeners) {
      listener(event)
    }
  }

  function onTaskEvent(listener: TaskListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /**
   * Wait until inFlight drops below the concurrency limit.
   */
  function waitForSlot(): Promise<void> {
    if (inFlight.size < config.concurrency) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      slotOpen = resolve
    })
  }

  function releaseSlot() {
    if (slotOpen && inFlight.size < config.concurrency) {
      const resolve = slotOpen
      slotOpen = null
      resolve()
    }
  }

  /**
   * The main loop. Pulls from the watcher generator continuously,
   * waiting for concurrency slots as needed.
   */
  async function run() {
    while (!stopped) {
      try {
        for await (const task of watcher.fetch()) {
          if (stopped) return

          // Validate
          if (!task.id || !task.title) continue

          // Skip tasks already in-flight
          if (inFlight.has(task.id)) continue

          // Wait for a concurrency slot
          await waitForSlot()
          if (stopped) return

          // Dispatch
          inFlight.add(task.id)
          const handle = dispatch(task)
          emit(task, "in_progress", handle.pid)
          handle.done
            .then(() => emit(task, "complete", handle.pid))
            .catch(() => emit(task, "error", handle.pid))
            .finally(() => {
              inFlight.delete(task.id)
              releaseSlot()
            })
        }
      } catch (err) {
        // Watcher fetch failed -- wait then retry
      }

      // Generator exhausted -- wait before starting a fresh pass
      if (!stopped) {
        await new Promise<void>((resolve) => {
          pollResolve = resolve
          pollTimer = setTimeout(() => {
            pollTimer = null
            pollResolve = null
            resolve()
          }, config.pollInterval)
        })
      }
    }
  }

  function start(): () => void {
    run()
    return () => {
      stopped = true
      // Cancel the poll-interval sleep so run() can exit immediately
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      if (pollResolve) {
        pollResolve()
        pollResolve = null
      }
      // Unblock anything waiting for a slot so the loop can exit
      releaseSlot()
    }
  }

  return { start, inFlight, onTaskEvent }
}
