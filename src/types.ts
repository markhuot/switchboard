export interface SwitchboardConfig {
  /** Parsed from --poll-interval. Milliseconds. */
  pollInterval: number

  /** Parsed from --concurrency. Max simultaneous agents. */
  concurrency: number

  /** Raw --watch value, after mode resolution. */
  watch: string

  /** Agent name or path (from --agent). Passed to agent.sh. */
  agent: string

  /** Path to the commands directory (from --dispatch). */
  dispatch: string
}

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
}

export interface Watcher {
  /**
   * Yields tasks one at a time as an async generator. The orchestrator
   * pulls from the generator continuously, dispatching each task as a
   * concurrency slot opens. When the generator is exhausted the
   * orchestrator waits pollInterval then calls fetch() again for a
   * fresh pass over the source data.
   *
   * The watcher owns all filtering. Switchboard dispatches from
   * whatever this yields.
   */
  fetch(): AsyncGenerator<Task>
}

export interface DispatchHandle {
  /** PID of the spawned subprocess. */
  pid: number
  /** Resolves when the subprocess exits successfully, rejects on error. */
  done: Promise<void>
}

/**
 * A dispatch function that processes a single task. The orchestrator
 * fires this for each task it pulls from the watcher. It returns a
 * handle with the subprocess PID and a promise that resolves when the
 * work is done (or rejects on error).
 */
export type Dispatcher = (task: Task) => DispatchHandle
