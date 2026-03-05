import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { exportCommands, COMMAND_FILES } from "./export"
import {
  DEFAULT_INIT_SH,
  DEFAULT_TEARDOWN_SH,
  DEFAULT_TEARDOWN_MD,
  DEFAULT_AGENT_SH,
  DEFAULT_WORK_MD,
} from "./dispatcher"

// Use .tmp/ as the test sandbox (already gitignored)
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "export-test")

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// exportCommands
// ---------------------------------------------------------------------------

describe("exportCommands", () => {
  test("creates .switchboard/commands/ and writes all default files", () => {
    const result = exportCommands(TEST_ROOT)

    // All files should be written
    expect(result.files).toHaveLength(Object.keys(COMMAND_FILES).length)
    for (const f of result.files) {
      expect(f.action).toBe("write")
    }

    // Verify each file exists on disk with the correct content
    const commandsDir = join(TEST_ROOT, ".switchboard", "commands")
    expect(existsSync(join(commandsDir, "init.sh"))).toBe(true)
    expect(existsSync(join(commandsDir, "work.md"))).toBe(true)
    expect(existsSync(join(commandsDir, "teardown.md"))).toBe(true)
    expect(existsSync(join(commandsDir, "teardown.sh"))).toBe(true)
    expect(existsSync(join(commandsDir, "agent.sh"))).toBe(true)

    expect(readFileSync(join(commandsDir, "init.sh"), "utf-8")).toBe(DEFAULT_INIT_SH)
    expect(readFileSync(join(commandsDir, "work.md"), "utf-8")).toBe(DEFAULT_WORK_MD)
    expect(readFileSync(join(commandsDir, "teardown.md"), "utf-8")).toBe(DEFAULT_TEARDOWN_MD)
    expect(readFileSync(join(commandsDir, "teardown.sh"), "utf-8")).toBe(DEFAULT_TEARDOWN_SH)
    expect(readFileSync(join(commandsDir, "agent.sh"), "utf-8")).toBe(DEFAULT_AGENT_SH)
  })

  test("skips files that already exist without overwriting", () => {
    const commandsDir = join(TEST_ROOT, ".switchboard", "commands")
    mkdirSync(commandsDir, { recursive: true })

    // Pre-create init.sh with custom content
    const customContent = "#!/bin/bash\n# My custom init\n"
    writeFileSync(join(commandsDir, "init.sh"), customContent)

    const result = exportCommands(TEST_ROOT)

    // init.sh should be skipped, others written
    const initResult = result.files.find((f) => f.filename === "init.sh")
    expect(initResult?.action).toBe("skip")

    const otherResults = result.files.filter((f) => f.filename !== "init.sh")
    for (const f of otherResults) {
      expect(f.action).toBe("write")
    }

    // Custom content should be preserved
    expect(readFileSync(join(commandsDir, "init.sh"), "utf-8")).toBe(customContent)
  })

  test("skips all files when all already exist", () => {
    const commandsDir = join(TEST_ROOT, ".switchboard", "commands")
    mkdirSync(commandsDir, { recursive: true })

    // Pre-create all files
    for (const filename of Object.keys(COMMAND_FILES)) {
      writeFileSync(join(commandsDir, filename), "custom")
    }

    const result = exportCommands(TEST_ROOT)

    for (const f of result.files) {
      expect(f.action).toBe("skip")
    }
  })

  test("is idempotent — second run skips everything", () => {
    // First run writes all files
    const first = exportCommands(TEST_ROOT)
    expect(first.files.every((f) => f.action === "write")).toBe(true)

    // Second run skips all files
    const second = exportCommands(TEST_ROOT)
    expect(second.files.every((f) => f.action === "skip")).toBe(true)

    // Content is still correct after second run
    const commandsDir = join(TEST_ROOT, ".switchboard", "commands")
    expect(readFileSync(join(commandsDir, "init.sh"), "utf-8")).toBe(DEFAULT_INIT_SH)
  })

  test("creates intermediate directories if they do not exist", () => {
    const deepRoot = join(TEST_ROOT, "nested", "project")
    // Don't pre-create anything — exportCommands should handle it
    const result = exportCommands(deepRoot)

    expect(result.files.every((f) => f.action === "write")).toBe(true)
    expect(existsSync(join(deepRoot, ".switchboard", "commands", "init.sh"))).toBe(true)
  })

  test("exports the expected set of filenames", () => {
    const result = exportCommands(TEST_ROOT)
    const filenames = result.files.map((f) => f.filename).sort()

    expect(filenames).toEqual([
      "agent.sh",
      "init.sh",
      "teardown.md",
      "teardown.sh",
      "work.md",
    ])
  })
})
