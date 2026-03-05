import { appendFileSync } from "fs"
import type { Dispatcher, LockStore, PutContext, StepResult, SwitchboardConfig, Task, TaskResults, Watcher } from "./types"

const DEBUG_LOG = ".switchboard/debug.log"
function dbg(msg: string) {
  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [orchestrator] ${msg}\n`)
}

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
 * When the generator is exhausted the orchestrator waits waitBetweenPolls
 * then calls fetch() again for a fresh pass.
 */
export function createOrchestrator(
  config: SwitchboardConfig,
  watcher: Watcher,
  dispatch: Dispatcher,
  lockStore?: LockStore,
) {
  const inFlight = new Set<string>()
  const listeners = new Set<TaskListener>()
  /** Latest event per task so late subscribers can catch up. */
  const currentEvents = new Map<string, TaskEvent>()
  let stopped = false

  // Resolvers waiting for a concurrency slot to open
  let slotOpen: (() => void) | null = null

  // Resolver + timer for the wait-between-polls sleep so stop() can cancel it
  let pollResolve: (() => void) | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  function emit(task: Task, status: TaskStatus, pid?: number) {
    const event: TaskEvent = { task, status, pid }
    // Track latest event so late subscribers can catch up
    if (status === "complete" || status === "error") {
      currentEvents.delete(task.id)
    } else {
      currentEvents.set(task.id, event)
    }
    for (const listener of listeners) {
      listener(event)
    }
  }

  function onTaskEvent(listener: TaskListener): () => void {
    listeners.add(listener)
    // Replay current in-flight events so late subscribers see existing tasks
    for (const event of currentEvents.values()) {
      listener(event)
    }
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
   * Build a TaskResults object from dispatch outcome.
   */
  function buildTaskResults(
    dispatchId: string,
    logDir: string,
    steps: StepResult[],
    status: "complete" | "error",
  ): TaskResults {
    return { status, dispatchId, logDir, steps }
  }

  /**
   * Build a PutContext that provides capabilities watchers may need
   * when writing back results (e.g. summarizing a work log).
   */
  function buildPutContext(logDir: string, output: Record<string, string>): PutContext {
    return {
      output,
      async summarize(input: string): Promise<string> {
        // Write input to a temp file and invoke the agent to summarize
        const { mkdirSync, writeFileSync } = await import("fs")
        const { join } = await import("path")
        const promptDir = join(logDir, ".prompts")
        mkdirSync(promptDir, { recursive: true })
        const inputPath = join(promptDir, "summarize-input.txt")
        writeFileSync(inputPath, input)

        const promptPath = join(promptDir, "summarize.md")
        writeFileSync(
          promptPath,
          `Summarize the following agent output concisely, suitable for posting as a comment on a task tracker:\n\n${input}`,
        )

        // Invoke the agent via the same agent.sh mechanism
        const agentScript = join(
          process.cwd(),
          config.dispatch,
          "agent.sh",
        )
        const proc = Bun.spawn(
          ["bash", "-lc", `bash "${agentScript}" "${config.agent}" "${promptPath}"`],
          { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        )

        const stdout = await new Response(proc.stdout).text()
        await proc.exited
        return stdout.trim()
      },
    }
  }

  /**
   * The main loop. Pulls from the watcher generator continuously,
   * waiting for concurrency slots as needed.
   */
  async function run() {
    dbg("run() started")
    while (!stopped) {
      dbg(`loop iteration, stopped=${stopped}, inFlight=${inFlight.size}`)
      try {
        dbg("calling watcher.fetch()")
        for await (const task of watcher.fetch()) {
          dbg(`got task: ${task.id} "${task.title}"`)
          if (stopped) { dbg("stopped=true after task, returning"); return }

          // Validate
          if (!task.id || !task.title) { dbg("invalid task, skipping"); continue }

          // Wait for a concurrency slot
          dbg(`waiting for slot, inFlight=${inFlight.size}, concurrency=${config.concurrency}`)
          await waitForSlot()
          dbg("slot acquired")
          if (stopped) { dbg("stopped=true after slot, returning"); return }

          // Dispatch -- the dispatcher generates its own dispatch ID
          const handle = dispatch(task)
          dbg(`dispatched task ${task.id}, pid=${handle.pid}`)

          // Authoritative check: acquire persistent lock (if lock store provided)
          if (lockStore) {
            try {
              const acquired = await lockStore.acquire(task.id, {
                dispatchId: handle.dispatchId,
              })
              if (!acquired) { dbg(`lock not acquired for ${task.id}, skipping`); continue }
              dbg(`lock acquired for ${task.id}`)
            } catch {
              // Lock store error -- skip this task, try again next tick
              dbg(`lock error for ${task.id}, skipping`)
              continue
            }
          }

          inFlight.add(task.id)
          emit(task, "in_progress", handle.pid)
          dbg(`task ${task.id} in flight, total inFlight=${inFlight.size}`)
          handle.done
            .then(async (steps) => {
              dbg(`task ${task.id} completed successfully`)
              // Build results for writeback
              task.results = buildTaskResults(
                handle.dispatchId,
                handle.logDir,
                steps,
                "complete",
              )
              emit(task, "complete", handle.pid)

              // Call watcher.put() if available
              if (watcher.put) {
                try {
                  await watcher.put(task, buildPutContext(handle.logDir, handle.output))
                } catch {
                  // Writeback failure -- log and continue
                }
              }
            })
            .catch(async () => {
              dbg(`task ${task.id} failed`)
              // Build error results for writeback
              task.results = buildTaskResults(
                handle.dispatchId,
                handle.logDir,
                [], // Steps may not be available on error path
                "error",
              )
              emit(task, "error", handle.pid)

              // Call watcher.put() even on failure
              if (watcher.put) {
                try {
                  await watcher.put(task, buildPutContext(handle.logDir, handle.output))
                } catch {
                  // Writeback failure -- log and continue
                }
              }
            })
            .finally(async () => {
              dbg(`task ${task.id} finally, releasing lock/slot, inFlight before=${inFlight.size}`)
              if (lockStore) {
                try {
                  await lockStore.release(task.id)
                } catch {
                  // Lock release failure -- JIT stale detection will clean up
                }
              }
              inFlight.delete(task.id)
              releaseSlot()
              dbg(`task ${task.id} cleaned up, inFlight after=${inFlight.size}`)
            })
        }
        dbg("generator exhausted (for-await ended)")
      } catch (err) {
        dbg(`watcher.fetch() threw: ${err}`)
        // Watcher fetch failed -- wait then retry
      }

      // Generator exhausted -- wait before starting a fresh pass
      if (!stopped) {
        dbg(`sleeping ${config.waitBetweenPolls}ms before next poll`)
        await new Promise<void>((resolve) => {
          pollResolve = resolve
          pollTimer = setTimeout(() => {
            pollTimer = null
            pollResolve = null
            resolve()
          }, config.waitBetweenPolls)
        })
        dbg("poll sleep finished")
      }
    }
    dbg("run() exited loop")
  }

  function start(): () => void {
    dbg("start() called")
    run()
    return () => {
      dbg("stop() called")
      stopped = true
      // Cancel the wait-between-polls sleep so run() can exit immediately
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
