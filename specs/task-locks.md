# Task Locks

Status: Complete

## Overview

Switchboard needs persistent lock state so that tasks being worked on are not picked up again -- by the same orchestrator on a future poll tick, or by another orchestrator running in parallel. Today, the orchestrator tracks in-flight tasks in a `Set<string>` that lives in memory. This works within a single run but does not survive restarts.

The lock store is an orchestrator-internal concern. Watchers do not interact with it. The watcher's only job is fetching tasks as fast as it can. The orchestrator checks the lock store before dispatching and releases the lock when the dispatch finishes (success or failure). The watcher handles the "completed" concern separately -- by updating the source so the task stops appearing in future fetches.

## LockStore Interface

```ts
interface LockStore {
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
```

Two methods. `acquire` and `release`. The store is only concerned with whether a task is currently being worked on.

There is no `complete()` method. The lock store does not track completed tasks. When a dispatch finishes, the lock is released. If the watcher's `put()` successfully updated the source, the task will not appear in future `fetch()` calls. If it does reappear (because writeback failed or the watcher does not support it), the task is available for re-dispatch -- which is the correct behavior.

There is no `status()` method. The only consumer is `acquire()`, which handles stale lock detection inline.

### LockMeta (internal)

The lock store records metadata for each lock. This is an internal concern -- callers pass only `dispatchId`, and the store fills in the rest:

```ts
interface LockMeta {
  /** Dispatch ID for this attempt. */
  dispatchId: string
  /** PID of the process that acquired the lock. Set by the store. */
  pid: number
  /** Timestamp when the lock was acquired. Set by the store. ISO 8601. */
  acquiredAt: string
}
```

## CLI

### `--task-ttl` (optional)

Maximum time a lock can be held before it is considered stale. Accepts the same human-readable duration format as `--poll-interval`.

```
switchboard --watch=jira --task-ttl=30m
switchboard --watch=jira --task-ttl=2h
```

Default: `1h` (1 hour).

This is a safety net for the PID-based stale lock detection. If a process is still running but hung, the TTL ensures the lock eventually expires and the task can be retried. The default is intentionally generous -- a 1-hour TTL means a misconfigured system burns at most 24 dispatches per day per task, giving operators time to notice and fix the problem.

The value is passed to the lock store at construction time. It is not a per-acquire parameter.

## Orchestrator Integration

The lock store replaces the in-memory `inFlight` set as the authoritative source of truth for task locking. The `inFlight` set can remain as a process-local fast path -- if this process already knows a task is in-flight, skip the I/O.

### Current loop (simplified)

```ts
for await (const task of watcher.fetch()) {
  if (inFlight.has(task.id)) continue
  inFlight.add(task.id)
  dispatch(task)
    .finally(() => inFlight.delete(task.id))
}
```

### With lock store

```ts
for await (const task of watcher.fetch()) {
  // Fast path: skip tasks this process is already working on
  if (inFlight.has(task.id)) continue

  // Dispatch -- the dispatcher generates its own dispatch ID
  const result = dispatch(task)

  // Authoritative check: acquire persistent lock
  const acquired = await lockStore.acquire(task.id, {
    dispatchId: result.dispatchId,
  })
  if (!acquired) continue

  inFlight.add(task.id)
  result.done
    .finally(async () => {
      await lockStore.release(task.id)
      inFlight.delete(task.id)
      releaseSlot()
    })
}
```

Key behaviors:

1. **`acquire` is the gate.** If it returns false, the task is locked by a live process. The orchestrator skips it.
2. **`release` in `finally`.** The lock is always released when dispatch finishes, regardless of success or failure. The watcher's `put()` handles source updates. If the watcher removed the task from its source, it will not be yielded again. If it did not, the task is available for retry.
3. **Stale lock detection is JIT.** When `acquire` finds an existing lock, it checks the lock's PID and TTL right then. No boot-time scan of the locks directory. No separate recovery step.
4. **`inFlight` remains.** It is a process-local fast path that avoids I/O for tasks this process is already working on.

## Memory-Based Implementation

The simplest backend. A `Map<string, LockMeta>` in memory. This is functionally equivalent to the existing `inFlight` set but conforms to the `LockStore` interface, making it easy to swap in a file-based or Redis-based backend later.

```ts
function createMemoryLockStore(ttl: number): LockStore {
  const locks = new Map<string, LockMeta>()

  return {
    async acquire(taskId, { dispatchId }) {
      const existing = locks.get(taskId)
      if (existing) {
        // Check TTL -- PID is always alive in-process
        const age = Date.now() - new Date(existing.acquiredAt).getTime()
        if (age < ttl) return false
        // TTL expired, treat as stale
        locks.delete(taskId)
      }

      locks.set(taskId, {
        dispatchId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      })
      return true
    },

    async release(taskId) {
      locks.delete(taskId)
    },
  }
}
```

The memory backend does not survive restarts. Tasks that were in-flight when the process died will be re-yielded by the watcher and dispatched again. This is acceptable for single-process development and testing.

PID-based stale detection is not meaningful for the memory backend (the map is gone if the process dies), but TTL still applies -- a stuck dispatch that exceeds the TTL will have its lock reclaimed on the next acquire attempt.

## File-Based Implementation

The file-based backend persists locks to disk. It survives restarts and supports multiple orchestrator processes on the same host.

### Directory structure

```
.switchboard/
  state/
    locks/
      {taskId}.lock          # in-progress lock files
```

The directory should be added to `.gitignore`. It is created lazily on first use.

### Atomic lock acquisition

Lock files are created with an exclusive write flag:

```ts
async function acquire(taskId: string, { dispatchId }): Promise<boolean> {
  const lockPath = join(stateDir, "locks", `${encodeTaskId(taskId)}.lock`)
  const meta: LockMeta = {
    dispatchId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }

  // Check for existing lock
  try {
    const existing = JSON.parse(readFileSync(lockPath, "utf-8")) as LockMeta
    if (!isStale(existing)) return false
    // Stale lock -- delete it and proceed
    unlinkSync(lockPath)
  } catch (err) {
    if (err.code !== "ENOENT") throw err
    // No existing lock -- proceed
  }

  // Attempt atomic creation
  try {
    writeFileSync(lockPath, JSON.stringify(meta, null, 2), { flag: "wx" })
    return true
  } catch (err) {
    if (err.code === "EEXIST") return false  // race: someone else got it
    throw err
  }
}
```

The `wx` flag (`O_CREAT | O_EXCL`) fails atomically if the file already exists. On a local filesystem this guarantees that two processes calling `acquire` concurrently for the same task will not both succeed.

### Stale lock detection (JIT)

When `acquire` finds an existing lock file, it checks staleness inline:

```ts
function isStale(meta: LockMeta): boolean {
  // Check if owning PID is still alive
  try {
    process.kill(meta.pid, 0)  // signal 0: existence check
  } catch {
    return true  // PID not running → stale
  }

  // Check TTL
  const age = Date.now() - new Date(meta.acquiredAt).getTime()
  return age > ttl
}
```

A lock is stale if **either** condition is true:
- The PID is no longer running (process crashed or was killed).
- The lock has exceeded the TTL (process is alive but hung, or PID was recycled).

There is no boot-time scan. Stale locks are discovered and cleaned up lazily when the next `acquire` call encounters them. This is simpler and avoids a startup delay when the locks directory is large.

### Lock file contents

```json
{
  "dispatchId": "a1b2c3d4",
  "pid": 12345,
  "acquiredAt": "2026-03-05T12:00:00.000Z"
}
```

### Release

```ts
async function release(taskId: string): Promise<void> {
  const lockPath = join(stateDir, "locks", `${encodeTaskId(taskId)}.lock`)
  try {
    unlinkSync(lockPath)
  } catch (err) {
    if (err.code !== "ENOENT") throw err
    // Already released (e.g., stale lock was cleaned up by another process)
  }
}
```

Release is idempotent. If the lock file is already gone, release succeeds silently.

### PID-based detection limitations

- **PID reuse.** If the OS has recycled the PID to a new process, the lock will not be detected as stale by PID alone. The TTL catches this case.
- **Cross-host.** PID checks only work on the same machine. Future backends (Redis, database) use TTL-based expiration exclusively.

Both limitations are acceptable for the file-based backend, which is inherently single-host.

## Task ID Encoding

Task IDs from external sources may contain characters that are not safe for filenames (slashes, colons, spaces, etc.). The file-based backend encodes task IDs for use as filenames.

Encoding strategy: replace any character that is not alphanumeric, hyphen, or underscore with its percent-encoded equivalent. For example:

| Task ID | Filename |
|---|---|
| `PROJ-123` | `PROJ-123.lock` |
| `org/repo#42` | `org%2Frepo%2342.lock` |
| `task with spaces` | `task%20with%20spaces.lock` |

This is a one-way mapping used only for storage. The original task ID is preserved in the lock file contents.

## Factory Function

The lock store is created via a factory that reads configuration and returns the appropriate backend:

```ts
function createLockStore(config: SwitchboardConfig): LockStore {
  const ttl = config.taskTtl  // parsed from --task-ttl, milliseconds

  // For now, file-based is the default persistent backend.
  // Memory backend is used for testing or single-run workflows.
  const stateDir = join(projectRoot, ".switchboard/state")
  return createFileLockStore(stateDir, ttl)
}
```

The orchestrator receives the lock store as a dependency, same as it receives the watcher and dispatcher:

```ts
const lockStore = createLockStore(config)
const orchestrator = createOrchestrator(config, watcher, dispatch, lockStore)
```

## Future Backends

The `LockStore` interface is designed so backends can be swapped without changing the orchestrator.

### Redis

A Redis backend would use `SET ... NX EX` for atomic acquisition with built-in TTL expiration. This enables multi-host orchestrators sharing a single task source.

```
SET lock:{taskId} {meta} NX EX 3600
```

PID-based detection is not applicable cross-host. TTL is the sole staleness mechanism.

### Database

A database backend (SQLite, Postgres) would use a `task_locks` table with a unique constraint on `task_id`. `INSERT ... ON CONFLICT DO NOTHING` provides atomic acquisition. Stale lock detection queries for rows where `acquired_at + ttl < now()`.

### Configuration

When additional backends are added, a CLI flag or config option will select the backend:

```
switchboard --watch=jira --lock-store=file          # default
switchboard --watch=jira --lock-store=redis://...
switchboard --watch=jira --lock-store=sqlite://...
```

The file-based backend remains the default. No flag is needed until a second backend ships.

## Error Handling

The lock store is on the critical path. If it fails, the orchestrator cannot safely dispatch tasks.

| Scenario | Behavior |
|---|---|
| `acquire` throws (I/O error) | Log error. Skip this task. Try again next tick. |
| `release` throws | Log error. Lock file remains. JIT stale detection will clean it up on next acquire. |
| State directory unwritable | Log error at startup. Exit. |

The orchestrator wraps every lock store call in a try/catch. Lock store failures never crash Switchboard.

## Next Steps

1. Add `taskTtl` to `SwitchboardConfig` and parse `--task-ttl` in `parseArgs`.
2. Define the `LockStore` interface in `src/types.ts`.
3. Implement `createMemoryLockStore()` in `src/lock-store.ts`.
4. Implement `createFileLockStore()` in `src/lock-store.ts`.
5. Wire the lock store into `createOrchestrator()`.
6. Add `.switchboard/state/` to the default `.gitignore` handling (same pattern as `.switchboard/logs/`).
7. Add tests for both backends: atomic acquisition, release, stale lock detection (PID + TTL), task ID encoding.
