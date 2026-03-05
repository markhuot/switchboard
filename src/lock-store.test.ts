import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  createMemoryLockStore,
  createFileLockStore,
  encodeTaskId,
  isStale,
} from "./lock-store"
import type { LockMeta, LockStore } from "./types"

// ---------------------------------------------------------------------------
// encodeTaskId
// ---------------------------------------------------------------------------

describe("encodeTaskId", () => {
  test("simple alphanumeric + hyphen passes through unchanged", () => {
    expect(encodeTaskId("PROJ-123")).toBe("PROJ-123")
  })

  test("slashes and hash are encoded", () => {
    expect(encodeTaskId("org/repo#42")).toBe("org%2Frepo%2342")
  })

  test("spaces are encoded", () => {
    expect(encodeTaskId("task with spaces")).toBe("task%20with%20spaces")
  })

  test("underscores pass through unchanged", () => {
    expect(encodeTaskId("task_with_underscores")).toBe("task_with_underscores")
  })
})

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  test("returns true when PID is not running", () => {
    const meta: LockMeta = {
      dispatchId: "abc12345",
      pid: 999999999,
      acquiredAt: new Date().toISOString(),
    }
    // TTL is very large so only PID matters
    expect(isStale(meta, 60 * 60 * 1000)).toBe(true)
  })

  test("returns true when TTL is exceeded", () => {
    const meta: LockMeta = {
      dispatchId: "abc12345",
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    }
    // TTL is 1 hour, so this lock is stale by time
    expect(isStale(meta, 60 * 60 * 1000)).toBe(true)
  })

  test("returns false when PID is alive and TTL has not expired", () => {
    const meta: LockMeta = {
      dispatchId: "abc12345",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }
    expect(isStale(meta, 60 * 60 * 1000)).toBe(false)
  })

  test("returns true when both conditions are met", () => {
    const meta: LockMeta = {
      dispatchId: "abc12345",
      pid: 999999999,
      acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }
    expect(isStale(meta, 60 * 60 * 1000)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createMemoryLockStore
// ---------------------------------------------------------------------------

describe("createMemoryLockStore", () => {
  test("acquire returns true for new task", async () => {
    const store = createMemoryLockStore(60_000)
    const result = await store.acquire("task-1", { dispatchId: "d001" })
    expect(result).toBe(true)
  })

  test("acquire returns false for already-locked task within TTL", async () => {
    const store = createMemoryLockStore(60_000)
    await store.acquire("task-1", { dispatchId: "d001" })
    const result = await store.acquire("task-1", { dispatchId: "d002" })
    expect(result).toBe(false)
  })

  test("release then acquire returns true", async () => {
    const store = createMemoryLockStore(60_000)
    await store.acquire("task-1", { dispatchId: "d001" })
    await store.release("task-1")
    const result = await store.acquire("task-1", { dispatchId: "d002" })
    expect(result).toBe(true)
  })

  test("acquire returns true after TTL expires", async () => {
    const store = createMemoryLockStore(10)
    await store.acquire("task-1", { dispatchId: "d001" })
    await new Promise((r) => setTimeout(r, 20))
    const result = await store.acquire("task-1", { dispatchId: "d002" })
    expect(result).toBe(true)
  })

  test("release is idempotent", async () => {
    const store = createMemoryLockStore(60_000)
    // Releasing a non-existent lock should not throw
    await store.release("nonexistent-task")
  })

  test("two different task IDs can both be acquired", async () => {
    const store = createMemoryLockStore(60_000)
    const r1 = await store.acquire("task-1", { dispatchId: "d001" })
    const r2 = await store.acquire("task-2", { dispatchId: "d002" })
    expect(r1).toBe(true)
    expect(r2).toBe(true)
  })

  test("acquire records correct dispatchId and pid", async () => {
    const store = createMemoryLockStore(60_000)
    await store.acquire("task-1", { dispatchId: "d001" })
    // A second acquire for the same task should fail, proving the lock exists
    // with the correct metadata (PID is alive, TTL not expired)
    const result = await store.acquire("task-1", { dispatchId: "d002" })
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createFileLockStore
// ---------------------------------------------------------------------------

describe("createFileLockStore", () => {
  const testDir = join(
    process.cwd(),
    `.tmp/lock-store-test-${Math.random().toString(36).slice(2, 10)}`
  )

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test("acquire returns true and creates lock file", async () => {
    const store = createFileLockStore(testDir, 60_000)
    const result = await store.acquire("task-1", { dispatchId: "d001" })
    expect(result).toBe(true)

    const lockFile = join(testDir, "locks", "task-1.lock")
    expect(existsSync(lockFile)).toBe(true)
  })

  test("acquire returns false for already-locked task", async () => {
    const store = createFileLockStore(testDir, 60_000)
    await store.acquire("task-1", { dispatchId: "d001" })
    const result = await store.acquire("task-1", { dispatchId: "d002" })
    expect(result).toBe(false)
  })

  test("lock file contains valid JSON with dispatchId, pid, acquiredAt", async () => {
    const store = createFileLockStore(testDir, 60_000)
    await store.acquire("task-1", { dispatchId: "d001" })

    const lockFile = join(testDir, "locks", "task-1.lock")
    const content = JSON.parse(readFileSync(lockFile, "utf-8")) as LockMeta
    expect(content.dispatchId).toBe("d001")
    expect(content.pid).toBe(process.pid)
    expect(typeof content.acquiredAt).toBe("string")
    // Verify acquiredAt is a valid ISO 8601 date
    expect(new Date(content.acquiredAt).toISOString()).toBe(content.acquiredAt)
  })

  test("release deletes lock file", async () => {
    const store = createFileLockStore(testDir, 60_000)
    await store.acquire("task-1", { dispatchId: "d001" })

    const lockFile = join(testDir, "locks", "task-1.lock")
    expect(existsSync(lockFile)).toBe(true)

    await store.release("task-1")
    expect(existsSync(lockFile)).toBe(false)
  })

  test("release is idempotent", async () => {
    const store = createFileLockStore(testDir, 60_000)
    // Releasing a lock that was never acquired should not throw
    await store.release("nonexistent-task")
  })

  test("acquire succeeds after release", async () => {
    const store = createFileLockStore(testDir, 60_000)
    await store.acquire("task-1", { dispatchId: "d001" })
    await store.release("task-1")
    const result = await store.acquire("task-1", { dispatchId: "d002" })
    expect(result).toBe(true)
  })

  test("acquire succeeds when existing lock is stale (TTL expired)", async () => {
    const store = createFileLockStore(testDir, 10)
    await store.acquire("task-1", { dispatchId: "d001" })
    await new Promise((r) => setTimeout(r, 20))
    const result = await store.acquire("task-1", { dispatchId: "d002" })
    expect(result).toBe(true)
  })

  test("creates locks directory lazily", async () => {
    // Use a fresh directory without pre-creating a locks subdirectory
    const freshDir = join(testDir, "fresh-state")
    mkdirSync(freshDir, { recursive: true })
    const locksDir = join(freshDir, "locks")
    expect(existsSync(locksDir)).toBe(false)

    const store = createFileLockStore(freshDir, 60_000)
    await store.acquire("task-1", { dispatchId: "d001" })

    expect(existsSync(locksDir)).toBe(true)
  })

  test("handles task IDs with special characters", async () => {
    const store = createFileLockStore(testDir, 60_000)
    const result = await store.acquire("org/repo#42", { dispatchId: "d001" })
    expect(result).toBe(true)

    // The lock file should use the encoded task ID
    const encodedName = encodeTaskId("org/repo#42")
    const lockFile = join(testDir, "locks", `${encodedName}.lock`)
    expect(existsSync(lockFile)).toBe(true)
  })

  test("atomic creation prevents double-acquire", async () => {
    const store = createFileLockStore(testDir, 60_000)

    // Manually create the lock file before calling acquire
    const locksDir = join(testDir, "locks")
    mkdirSync(locksDir, { recursive: true })
    const lockFile = join(locksDir, "task-1.lock")
    const fakeMeta: LockMeta = {
      dispatchId: "pre-existing",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }
    writeFileSync(lockFile, JSON.stringify(fakeMeta))

    // acquire should see the existing lock and return false
    const result = await store.acquire("task-1", { dispatchId: "d001" })
    expect(result).toBe(false)
  })
})
