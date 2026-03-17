import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { dirname, join } from "path"
import type {
  CompleteContext,
  Dispatcher,
  LockStore,
  StepResult,
  SwitchboardConfig,
  Task,
  TaskResults,
  UpdateContext,
  Watcher,
} from "./types"
import { DEFAULT_AGENT_SH, generateDispatchId, normalizeWatcherName } from "./dispatcher"

export type TaskStatus = "in_progress" | "complete" | "error"

export interface TaskEvent {
  task: Task
  status: TaskStatus
  /** PID of the spawned subprocess (set once dispatch resolves). */
  pid?: number
  /** Absolute path to the dispatch log directory for this attempt. */
  logDir?: string
  /** Dispatch ID for this attempt. */
  dispatchId?: string
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
  // Console patching for complete() capture is process-global; serialize it.
  let completeCaptureQueue: Promise<void> = Promise.resolve()

  function stringifyConsoleArg(arg: unknown): string {
    if (typeof arg === "string") return arg
    if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
    try {
      return JSON.stringify(arg)
    } catch {
      return String(arg)
    }
  }

  function formatError(err: unknown): string {
    if (err instanceof Error) {
      return err.stack ?? `${err.name}: ${err.message}`
    }
    return stringifyConsoleArg(err)
  }

  function appendCompleteLog(logDir: string, lines: string[]) {
    const logPath = join(logDir, "watcher.complete.log")
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${lines.join("\n")}\n`, "utf-8")
  }

  function buildUpdateContext(task: Task, dispatchId: string): UpdateContext {
    const identifier = task.identifier ?? task.id
    return {
      dispatchId,
      logDir: join(
        process.cwd(),
        ".switchboard/logs",
        normalizeWatcherName(config.watch),
        identifier,
        dispatchId,
      ),
    }
  }

  async function runWatcherUpdate(task: Task, context: UpdateContext): Promise<void> {
    if (!watcher.update) return
    await watcher.update(task, context)
  }

  async function runWatcherComplete(task: Task, context: CompleteContext): Promise<void> {
    if (!watcher.complete || !task.results) return

    const run = completeCaptureQueue.then(async () => {
      const lines: string[] = []
      const start = new Date().toISOString()
      lines.push(`[${start}] watcher.complete start task=${task.id} status=${task.results!.status}`)

      const originalLog = console.log
      const originalWarn = console.warn
      const originalError = console.error

      const capture = (level: "log" | "warn" | "error", args: unknown[]) => {
        lines.push(
          `[${new Date().toISOString()}] console.${level}: ${args.map(stringifyConsoleArg).join(" ")}`,
        )
      }

      console.log = (...args: unknown[]) => {
        capture("log", args)
        originalLog(...args)
      }
      console.warn = (...args: unknown[]) => {
        capture("warn", args)
        originalWarn(...args)
      }
      console.error = (...args: unknown[]) => {
        capture("error", args)
        originalError(...args)
      }

      try {
        await watcher.complete!(task, context)
        lines.push(`[${new Date().toISOString()}] watcher.complete success`)
      } catch (err) {
        lines.push(`[${new Date().toISOString()}] watcher.complete error: ${formatError(err)}`)
        throw err
      } finally {
        console.log = originalLog
        console.warn = originalWarn
        console.error = originalError
        appendCompleteLog(task.results!.logDir, lines)
      }
    })

    completeCaptureQueue = run.then(() => undefined, () => undefined)
    return run
  }

  function emit(task: Task, status: TaskStatus, pid?: number, logDir?: string, dispatchId?: string) {
    const event: TaskEvent = { task, status, pid, logDir, dispatchId }
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
   * Build a CompleteContext that provides capabilities watchers may need
   * when writing back results (e.g. summarizing a work log).
   */
  function buildCompleteContext(logDir: string, output: Record<string, string>): CompleteContext {
    return {
      output,
      async summarize(input: string): Promise<string> {
        // Write input to a temp file and invoke the agent to summarize
        const { writeFileSync } = await import("fs")
        const promptDir = join(logDir, ".prompts")
        mkdirSync(promptDir, { recursive: true })
        const inputPath = join(promptDir, "summarize-input.txt")
        writeFileSync(inputPath, input)

        const promptPath = join(promptDir, "summarize.md")
        writeFileSync(
          promptPath,
          [
            "Summarize the agent output in the file below, suitable for posting as a concise comment on a task tracker.",
            "",
            `Read this file from disk: ${inputPath}`,
            "",
            "Return only the summary text.",
          ].join("\n"),
        )

        // Resolve project-specific agent.sh with fallback to built-in default.
        const projectAgentScriptPath = join(process.cwd(), config.dispatch, "agent.sh")
        const agentScript = existsSync(projectAgentScriptPath)
          ? readFileSync(projectAgentScriptPath, "utf-8")
          : DEFAULT_AGENT_SH
        const agentScriptSource = existsSync(projectAgentScriptPath)
          ? projectAgentScriptPath
          : "default"
        const agentScriptPath = join(promptDir, "agent.sh")
        writeFileSync(agentScriptPath, agentScript)

        const proc = Bun.spawn(
          ["bash", "-lc", `bash "${agentScriptPath}" "${config.agent}" "${promptPath}"`],
          { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        )

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])

        const summarizeLogPath = join(logDir, "summarize.log")
        const timestamp = new Date().toISOString()
        appendFileSync(
          summarizeLogPath,
          [
            `[${timestamp}] summarize prompt=${promptPath}`,
            `[${timestamp}] summarize input=${inputPath}`,
            `[${timestamp}] summarize agent_script=${agentScriptSource}`,
            `[${timestamp}] summarize exit_code=${exitCode}`,
            `[${timestamp}] summarize stdout:`,
            stdout || "(empty)",
            `[${timestamp}] summarize stderr:`,
            stderr || "(empty)",
            "",
          ].join("\n"),
          "utf-8",
        )

        if (exitCode !== 0) {
          console.warn(`Summarization agent exited with code ${exitCode}`)
        }

        return stdout.trim()
      },
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

          // Skip tasks already being processed
          if (inFlight.has(task.id)) continue

           // Wait for a concurrency slot
          await waitForSlot()
          if (stopped) return

          // Generate the dispatch ID upfront so we can acquire the lock
          // before spawning any subprocess.
          const dispatchId = generateDispatchId()

          // Authoritative check: acquire persistent lock (if lock store provided)
          if (lockStore) {
            try {
              const acquired = await lockStore.acquire(task.id, {
                dispatchId,
              })
              if (!acquired) continue
            } catch {
              // Lock store error -- skip this task, try again next tick
              continue
            }
          }

          // Track before dispatching so subsequent yields of the same
          // task ID within this poll pass are naturally skipped by the
          // lock store (cross-process) or waitForSlot accounting.
          inFlight.add(task.id)

          try {
            await runWatcherUpdate(task, buildUpdateContext(task, dispatchId))
          } catch {
            if (lockStore) {
              try {
                await lockStore.release(task.id)
              } catch {
                // Lock release failure -- JIT stale detection will clean up
              }
            }
            inFlight.delete(task.id)
            releaseSlot()
            continue
          }

          const handle = dispatch(task, dispatchId)
          emit(task, "in_progress", handle.pid, handle.logDir, handle.dispatchId)
          handle.done
            .then(async (steps) => {
              // Build results for writeback
              task.results = buildTaskResults(
                handle.dispatchId,
                handle.logDir,
                steps,
                "complete",
              )

              try {
                await runWatcherComplete(task, buildCompleteContext(handle.logDir, handle.output))
                emit(task, "complete", handle.pid, handle.logDir, handle.dispatchId)
              } catch {
                // If writeback fails, treat the task as failed.
                task.results = buildTaskResults(
                  handle.dispatchId,
                  handle.logDir,
                  steps,
                  "error",
                )
                emit(task, "error", handle.pid, handle.logDir, handle.dispatchId)
              }
            })
            .catch(async () => {
              // Build error results for writeback
              task.results = buildTaskResults(
                handle.dispatchId,
                handle.logDir,
                [], // Steps may not be available on error path
                "error",
              )
              emit(task, "error", handle.pid, handle.logDir, handle.dispatchId)

              // Call watcher.complete() even on failure
              try {
                await runWatcherComplete(task, buildCompleteContext(handle.logDir, handle.output))
              } catch {
                // The task is already marked error; keep it that way.
              }
            })
            .finally(async () => {
              if (lockStore) {
                try {
                  await lockStore.release(task.id)
                } catch {
                  // Lock release failure -- JIT stale detection will clean up
                }
              }
              inFlight.delete(task.id)
              releaseSlot()
            })
        }
      } catch {
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
          }, config.waitBetweenPolls)
        })
      }
    }
  }

  function start(): () => void {
    run()
    return () => {
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
