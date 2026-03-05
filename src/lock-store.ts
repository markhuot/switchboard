import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { LockMeta, LockStore, SwitchboardConfig } from "./types"

/**
 * Replace any character that is not alphanumeric, hyphen, or underscore
 * with its percent-encoded equivalent.
 */
export function encodeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9\-_]/g, (ch) => {
    return "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")
  })
}

/**
 * Check whether a lock is stale. A lock is stale if the owning PID is
 * no longer running OR the lock has exceeded the TTL.
 */
export function isStale(meta: LockMeta, ttl: number): boolean {
  // Check if the process is still alive using signal 0
  try {
    process.kill(meta.pid, 0)
  } catch {
    // PID is dead — lock is stale
    return true
  }

  // Check TTL
  if (Date.now() - new Date(meta.acquiredAt).getTime() > ttl) {
    return true
  }

  return false
}

/**
 * Create an in-memory lock store backed by a Map.
 */
export function createMemoryLockStore(ttl: number): LockStore {
  const locks = new Map<string, LockMeta>()

  return {
    async acquire(taskId, meta) {
      const existing = locks.get(taskId)
      if (existing) {
        if (!isStale(existing, ttl)) {
          return false
        }
        locks.delete(taskId)
      }

      locks.set(taskId, {
        dispatchId: meta.dispatchId,
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

/**
 * Create a file-based lock store that persists locks as JSON files
 * under `{stateDir}/locks/`.
 */
export function createFileLockStore(stateDir: string, ttl: number): LockStore {
  const locksDir = join(stateDir, "locks")

  function lockPath(taskId: string): string {
    return join(locksDir, `${encodeTaskId(taskId)}.lock`)
  }

  return {
    async acquire(taskId, meta) {
      const path = lockPath(taskId)

      // Check for an existing lock
      if (existsSync(path)) {
        try {
          const existing: LockMeta = JSON.parse(readFileSync(path, "utf-8"))
          if (!isStale(existing, ttl)) {
            return false
          }
          // Stale — remove it and proceed
          unlinkSync(path)
        } catch {
          // If we can't read/parse the file, remove it and proceed
          try { unlinkSync(path) } catch { /* ignore */ }
        }
      }

      // Ensure the locks directory exists
      mkdirSync(locksDir, { recursive: true })

      const lockMeta: LockMeta = {
        dispatchId: meta.dispatchId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }

      // Attempt atomic creation — wx flag fails if file already exists
      try {
        writeFileSync(path, JSON.stringify(lockMeta, null, 2), { flag: "wx" })
      } catch (err: any) {
        if (err?.code === "EEXIST") {
          return false // Another process won the race
        }
        throw err
      }

      return true
    },

    async release(taskId) {
      try {
        unlinkSync(lockPath(taskId))
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          throw err
        }
        // ENOENT is fine — idempotent release
      }
    },
  }
}

/**
 * Factory function that creates the default lock store for a
 * Switchboard instance — a file-based store under .switchboard/state.
 */
export function createLockStore(config: SwitchboardConfig): LockStore {
  const stateDir = join(process.cwd(), ".switchboard/state")
  return createFileLockStore(stateDir, config.taskTtl)
}
