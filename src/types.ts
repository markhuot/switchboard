export interface SwitchboardConfig {
  /** Parsed from --wait-between-polls. Milliseconds. */
  waitBetweenPolls: number

  /** Parsed from --concurrency. Max simultaneous agents. */
  concurrency: number

  /** Raw --watch value, after mode resolution. */
  watch: string

  /** Agent name or path (from --agent). Passed to agent.sh. */
  agent: string

  /** Path to the commands directory (from --dispatch). */
  dispatch: string

  /** When true, use plain line-by-line output instead of the full-screen TUI. */
  noTty: boolean

  /** Parsed from --task-ttl. Maximum lock hold time in milliseconds. Default: 1h. */
  taskTtl: number
}

export interface StepResult {
  /** Step name, matching the lifecycle file (e.g., "init.sh", "work.md"). */
  name: string
  /** Process exit code. 0 = success, non-zero = failure. */
  exitCode: number
}

export interface TaskResults {
  /** Overall dispatch outcome. */
  status: "complete" | "error"

  /** Dispatch ID for this attempt. */
  dispatchId: string

  /** Absolute path to the log directory for this dispatch attempt. */
  logDir: string

  /** Exit code and name for each lifecycle step that ran. */
  steps: StepResult[]
}

/**
 * A Task is a pure data transfer object (DTO) representing a unit of
 * work from an external source. It must be fully serializable to JSON
 * — do not attach methods or non-serializable state.
 */
export interface Task {
  /** Stable external ID from the task source (e.g., Jira issue key, GitHub issue number). */
  id: string

  /** Human-readable identifier (e.g., "PROJ-123", "#42"). Falls back to id if unset. */
  identifier?: string

  /** Task title / summary. */
  title: string

  /** Full description or body text. Null if unavailable. */
  description: string | null

  /** URL to the task in the external service. Null if unavailable. */
  url: string | null

  /** Priority as an integer. Lower is higher priority. Null if unavailable. */
  priority: number | null

  /**
   * Dispatch results. Undefined when the task is yielded by fetch().
   * Populated by the orchestrator before calling put().
   */
  results?: TaskResults
}

/**
 * Context passed to `Watcher.put()` by the orchestrator, providing
 * capabilities that watchers may need when writing back results.
 */
export interface PutContext {
  /**
   * Invoke the configured agent to produce a concise summary of the
   * given input text (e.g. a work log). Useful for posting human-readable
   * comments back to a task tracker.
   */
  summarize(input: string): Promise<string>
}

export interface Watcher {
  /**
   * Yields tasks one at a time as an async generator. The orchestrator
   * pulls from the generator continuously, dispatching each task as a
   * concurrency slot opens. When the generator is exhausted the
   * orchestrator waits waitBetweenPolls then calls fetch() again for a
   * fresh pass over the source data.
   *
   * The watcher owns all filtering. Switchboard dispatches from
   * whatever this yields.
   */
  fetch(): AsyncGenerator<Task>

  /**
   * Write a completed task back to the source. Called by the
   * orchestrator after dispatch finishes (success or failure).
   *
   * The task object carries dispatch results so the watcher can
   * inspect what happened and decide how to update the source.
   *
   * Optional. Watchers that do not support writeback omit this method.
   * The orchestrator checks for its existence before calling.
   */
  put?(task: Task, context: PutContext): Promise<void>
}

export interface DispatchHandle {
  /** PID of the spawned subprocess. */
  pid: number
  /** Dispatch ID for this attempt. */
  dispatchId: string
  /** Absolute path to the log directory for this dispatch attempt. */
  logDir: string
  /** Resolves with per-step results when the subprocess exits. */
  done: Promise<StepResult[]>
}

/**
 * A dispatch function that processes a single task. The orchestrator
 * fires this for each task it pulls from the watcher. It returns a
 * handle with the subprocess PID and a promise that resolves when the
 * work is done (or rejects on error).
 */
export type Dispatcher = (task: Task) => DispatchHandle

// ---------------------------------------------------------------------------
// Lock store
// ---------------------------------------------------------------------------

export interface LockMeta {
  /** Dispatch ID for this attempt. */
  dispatchId: string
  /** PID of the process that acquired the lock. Set by the store. */
  pid: number
  /** Timestamp when the lock was acquired. Set by the store. ISO 8601. */
  acquiredAt: string
}

export interface LockStore {
  /**
   * Attempt to acquire an exclusive lock on a task. Returns true if
   * the lock was acquired, false if the task is already locked by a
   * live process within the TTL window.
   *
   * This is an atomic operation. Two concurrent callers for the same
   * taskId will never both receive true.
   *
   * If an existing lock is found, the store checks whether it is
   * stale before returning false. A lock is stale if the owning PID
   * is no longer running or the lock has exceeded the TTL. Stale
   * locks are deleted and the acquire proceeds as if no lock existed.
   *
   * The store automatically records the current PID and timestamp.
   * Callers only need to provide a dispatch ID.
   */
  acquire(taskId: string, meta: { dispatchId: string }): Promise<boolean>

  /**
   * Release a lock. The task becomes available for dispatch on a
   * future poll tick.
   */
  release(taskId: string): Promise<void>
}
