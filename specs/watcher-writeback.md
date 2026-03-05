# Watcher Writeback

Status: Complete

## Overview

When a task completes, the source system should be updated so the watcher stops yielding it on future poll ticks. Today, the watcher is read-only -- it fetches tasks but has no way to write back. This means completed tasks reappear on every poll until they are manually updated in the source or until the lock expires and the task is re-dispatched.

Writeback adds an optional `put()` method to the `Watcher` interface. The orchestrator calls it after dispatch completes, passing the task enriched with dispatch results. The watcher implementation decides what "update the source" means -- transition a Jira ticket, close a GitHub issue, mark a row in a database, or do nothing at all.

The watcher's `fetch()` remains its primary job: yield tasks as fast as possible. `put()` is a secondary, optional responsibility. Watchers that do not support writeback simply omit the method.

## Updated Watcher Interface

```ts
interface Watcher {
  /**
   * Yields tasks one at a time as an async generator. Unchanged from
   * the original spec. The watcher owns all filtering. Switchboard
   * dispatches from whatever this yields.
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
  put?(task: Task): Promise<void>
}
```

One new optional method. That is the entire interface change.

## Task Results

After dispatch, the orchestrator populates a `results` field on the task before passing it to `put()`. This gives the watcher enough context to make informed decisions about how to update the source.

```ts
interface StepResult {
  /** Step name, matching the lifecycle file (e.g., "init.sh", "work.md"). */
  name: string
  /** Process exit code. 0 = success, non-zero = failure. */
  exitCode: number
}

interface TaskResults {
  /** Overall dispatch outcome. */
  status: "complete" | "error"

  /** Dispatch ID for this attempt. */
  dispatchId: string

  /** Absolute path to the log directory for this dispatch attempt. */
  logDir: string

  /** Exit code and name for each lifecycle step that ran. */
  steps: StepResult[]

  /**
   * Invoke the configured agent to summarize the given input text.
   * Returns the agent's response as a string.
   *
   * This reuses the same agent invocation machinery as the dispatcher
   * lifecycle (agent.sh, --agent flag). The watcher does not need to
   * know which agent is configured or how to invoke it.
   */
  summarize(input: string): Promise<string>
}
```

The `results` field is added to the existing `Task` interface as optional:

```ts
interface Task {
  id: string
  identifier?: string
  title: string
  description: string | null
  url: string | null
  priority: number | null

  /**
   * Dispatch results. Undefined when the task is yielded by fetch().
   * Populated by the orchestrator before calling put().
   */
  results?: TaskResults
}
```

### Design constraints

**No log content in results.** The `StepResult` carries only the step name and exit code -- never log text. Logs can be multi-megabyte. Storing them in `StepResult` would consume memory proportional to the total log output of every in-flight task. Instead, `logDir` provides the path. The watcher reads log files on demand if it needs them.

**Results are ephemeral.** The orchestrator creates the `TaskResults` object after dispatch finishes, passes it to `put()`, and discards it. It is never stored, serialized, or persisted. This means having a function (`summarize`) on the object is fine -- it does not need to be a pure data structure.

### What the watcher can learn from results

**Quick check -- did it work?**

```ts
if (task.results?.status === "complete") {
  // All steps succeeded. Transition the source to "Done."
}
```

**Per-step inspection:**

```ts
const workStep = task.results?.steps.find(s => s.name === "work.md")
if (workStep?.exitCode !== 0) {
  // The agent failed. Post a comment, transition to "Needs Triage."
}
```

**Reading logs for detail:**

The `logDir` path points to the dispatch attempt's log directory. The watcher can read log files to extract agent output, error messages, or summaries.

```ts
import { readFileSync } from "fs"
import { join } from "path"

async function put(task: Task): Promise<void> {
  const workLog = readFileSync(join(task.results!.logDir, "work.md.log"), "utf-8")
  const summary = await task.results!.summarize(workLog)
  await postComment(task.id, summary)
}
```

## Agent-Generated Summaries

Watchers often need to post a human-readable summary when writing back to the source -- a Jira comment, a GitHub issue reply, a Linear update. Raw agent logs are too verbose and noisy. The `summarize` function on `TaskResults` lets the watcher delegate summarization to the configured agent.

### How it works

The orchestrator creates the `summarize` function after dispatch completes. It closes over the agent configuration (`--agent`, `agent.sh`) and the task context. When called:

1. The input text is written to a temporary file.
2. A summarization prompt is constructed (e.g., "Summarize the following agent output concisely, suitable for posting as a comment on a task tracker").
3. The agent is invoked via the same `agent.sh` mechanism the dispatcher uses for `.md` steps.
4. The agent's stdout is captured and returned as a string.

The prompt and invocation reuse the existing dispatcher machinery. No new agent integration is needed.

### Usage patterns

**Summarize the work log:**

```ts
async function put(task: Task): Promise<void> {
  const workLog = readFileSync(join(task.results!.logDir, "work.md.log"), "utf-8")
  const summary = await task.results!.summarize(workLog)
  await transitionIssue(task.id, "Done")
  await addComment(task.id, summary)
}
```

**Summarize only on failure:**

```ts
async function put(task: Task): Promise<void> {
  if (task.results?.status === "complete") {
    await transitionIssue(task.id, "Done")
  } else {
    const logs = task.results!.steps
      .map(s => {
        const logPath = join(task.results!.logDir, `${s.name}.log`)
        try { return readFileSync(logPath, "utf-8") } catch { return "" }
      })
      .join("\n---\n")
    const summary = await task.results!.summarize(logs)
    await addComment(task.id, `Dispatch failed:\n\n${summary}`)
  }
}
```

**Skip summarization entirely:**

The watcher is not required to call `summarize`. It can read logs directly, post a fixed message, or ignore the results altogether.

## Orchestrator Integration

The orchestrator calls `put()` after the dispatch lifecycle completes and before releasing the lock.

### Sequence

```
1. acquire lock
2. dispatch (init → work → teardown)
3. enrich task with results
4. call watcher.put(task)     ← new
5. release lock
```

### Implementation sketch

```ts
dispatch(task)
  .finally(async () => {
    task.results = buildTaskResults(dispatchId, logDir, steps, agentConfig)
    if (watcher.put) {
      try {
        await watcher.put(task)
      } catch (err) {
        // Log warning -- writeback failure does not affect lock release
      }
    }
    await lockStore.release(task.id)
    inFlight.delete(task.id)
    releaseSlot()
  })
```

Key behaviors:

1. **`put()` is called for both success and failure.** The watcher decides what to do based on `results.status`. A Jira watcher might transition to "Done" on success and post a failure comment on error.
2. **`put()` is called before the lock is released.** This ensures the task is not re-acquired by another orchestrator while writeback is in progress.
3. **`put()` is only called if the watcher implements it.** A simple `if (watcher.put)` check. No runtime error for watchers that omit it.
4. **`put()` failures do not block lock release.** If `put()` throws, the error is logged and the lock is still released. See **Error Handling**.

## Populating Step Results

The dispatcher currently throws on step failure but does not surface per-step exit codes to the orchestrator. To populate `TaskResults`, the dispatcher needs to collect step outcomes as the lifecycle runs.

### Changes to the dispatcher

The `runLifecycle` function collects a `StepResult[]` as it executes each step. On success, exit code is 0. On failure, the exit code from the failing step is captured.

```ts
const steps: StepResult[] = []

// init.sh
try {
  await runShellStep(commands["init.sh"], "init.sh", ctx)
  steps.push({ name: "init.sh", exitCode: 0 })
} catch (err) {
  steps.push({ name: "init.sh", exitCode: extractExitCode(err) })
  initFailed = true
}

// ... same pattern for each step ...
```

The dispatcher returns the collected `steps` array, `logDir`, and its `dispatchId` to the orchestrator so it can build the `TaskResults` object. The dispatch ID is generated by the dispatcher (not the orchestrator) because it is an implementation detail of how the dispatcher organizes its work. The orchestrator receives it as part of the dispatch result and passes it through to `TaskResults`. If future dispatchers are added (e.g., a remote execution backend), each dispatcher returns its own ID for its subsystem.

The exact return mechanism is an implementation detail. The key requirement is that the orchestrator has access to the `dispatchId`, `StepResult[]`, and `logDir` after the dispatch completes, regardless of success or failure.

## Per-Watcher Semantics

Each watcher implementation decides what `put()` does. The orchestrator does not prescribe behavior -- it just calls the method.

### Jira

On success:
- Transition the issue to a "Done" status (configurable via environment variable, e.g., `JIRA_DONE_TRANSITION`).
- Use `summarize()` to generate a comment from the work log.

On failure:
- Post a comment noting the failure with a summary of the error output.
- Optionally transition to a triage status.

```ts
async function put(task: Task): Promise<void> {
  const workLogPath = join(task.results!.logDir, "work.md.log")
  let summary: string

  try {
    const workLog = readFileSync(workLogPath, "utf-8")
    summary = await task.results!.summarize(workLog)
  } catch {
    summary = "(no work log available)"
  }

  if (task.results?.status === "complete") {
    await transitionIssue(task.id, process.env.JIRA_DONE_TRANSITION ?? "Done")
    await addComment(task.id, summary)
  } else {
    await addComment(task.id, `Dispatch failed:\n\n${summary}`)
  }
}
```

### GitHub

On success:
- Post a comment on the issue with an agent-generated summary.
- Optionally close the issue (configurable).

On failure:
- Post a comment with an agent-generated summary of the error.
- Leave the issue open.

### Linear

On success:
- Update the issue state to "Done."
- Post a summary comment.

On failure:
- Post a failure comment.

### File watcher

Does not implement `put()` in v1. Without writeback, the file watcher will re-yield completed tasks on the next poll. Since the lock store does not track completed tasks, these tasks will be re-dispatched. For file-based workflows this is acceptable -- the file is typically a one-shot input (pipe, test fixture) rather than a long-lived queue.

### Shell watcher

Does not implement `put()` in v1. Same re-dispatch behavior as the file watcher.

### Module watcher

User-provided TypeScript modules can implement `put()` directly. The factory function returns a `Watcher` with both methods:

```ts
export default function createWatcher(config: SwitchboardConfig): Watcher {
  return {
    async *fetch() {
      // ...yield tasks...
    },

    async put(task: Task) {
      if (task.results?.status === "complete") {
        await myApi.markDone(task.id)
      }
    },
  }
}
```

No changes needed to module resolution. The orchestrator checks for `put` on whatever the factory returns.

## Error Handling

### put() throws

If `put()` throws, the orchestrator logs the error as a warning. The lock is still released. The dispatch result (success or failure) stands independently of whether writeback succeeded.

| Dispatch result | put() result | Lock outcome | Behavior |
|---|---|---|---|
| Success | Success | Released | Normal path. Source updated. Task will not be re-yielded. |
| Success | Failure | Released | Source not updated. Task may be re-yielded and re-dispatched. Logged as warning. |
| Failure | Success | Released | Source updated with failure info. Task may be re-yielded for retry depending on source state. |
| Failure | Failure | Released | Source not updated. Task will be re-yielded and re-dispatched. Logged as warning. |

When dispatch succeeds but `put()` fails, the task will be re-yielded by the watcher (since the source was not updated) and may be re-dispatched. This is a known limitation. For most watchers, a failed `put()` is an API error (network timeout, auth failure) that will likely succeed on retry. The re-dispatch is wasteful but not harmful as long as the dispatch lifecycle is idempotent (e.g., the init script reuses an existing worktree and branch).

### put() timeout

Watcher `put()` implementations that call external APIs should handle their own timeouts (e.g., `AbortSignal.timeout(15_000)`), consistent with how `fetch()` implementations handle API timeouts today. The orchestrator does not enforce a timeout on `put()`.

### summarize() failure

If `summarize()` throws (agent crashed, timed out, not available), the watcher's `put()` implementation should catch the error and fall back -- post a generic message, skip the comment, or use raw log excerpts. The `summarize` function is a convenience, not a requirement. Watchers should not let a summarization failure prevent them from updating the source.

### Idempotency

Watcher `put()` implementations should be idempotent where possible. Idempotent operations (posting a comment, transitioning an already-transitioned issue) are safe to repeat if the task is re-dispatched due to a writeback failure.

## Next Steps

1. Add the optional `results` field to the `Task` interface in `src/types.ts`.
2. Define `StepResult` and `TaskResults` in `src/types.ts`.
3. Add the optional `put()` method to the `Watcher` interface in `src/types.ts`.
4. Implement the `summarize` function factory in the orchestrator or dispatcher.
5. Update the dispatcher to collect per-step exit codes and return them to the orchestrator.
6. Update the orchestrator to enrich the task with results and call `watcher.put()`.
7. Implement `put()` for the Jira watcher (transition + summary comment).
8. Add tests for the orchestrator's writeback integration (put called on success, put called on failure, put not called when absent, summarize invoked correctly).
