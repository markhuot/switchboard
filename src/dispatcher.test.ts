import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import {
  generateDispatchId,
  normalizeWatcherName,
  parseDirective,
  renderTemplate,
  createDispatcher,
  DEFAULT_INIT_SH,
  DEFAULT_TEARDOWN_SH,
  DEFAULT_TEARDOWN_MD,
  DEFAULT_AGENT_SH,
  DEFAULT_WORK_MD,
} from "./dispatcher"
import type { Task, SwitchboardConfig } from "./types"

// ---------------------------------------------------------------------------
// generateDispatchId
// ---------------------------------------------------------------------------

describe("generateDispatchId", () => {
  test("returns an 8-character string", () => {
    const id = generateDispatchId()
    expect(id).toHaveLength(8)
  })

  test("contains only hex characters", () => {
    const id = generateDispatchId()
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateDispatchId()))
    expect(ids.size).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// normalizeWatcherName
// ---------------------------------------------------------------------------

describe("normalizeWatcherName", () => {
  test("returns 'shell' for shell mode", () => {
    expect(normalizeWatcherName("$ echo hello")).toBe("shell")
  })

  test("returns built-in name as-is", () => {
    expect(normalizeWatcherName("jira")).toBe("jira")
    expect(normalizeWatcherName("linear")).toBe("linear")
    expect(normalizeWatcherName("github")).toBe("github")
  })

  test("extracts basename without extension for file paths", () => {
    expect(normalizeWatcherName("./watchers/my-watcher.ts")).toBe("my-watcher")
    expect(normalizeWatcherName("/abs/path/to/custom.sh")).toBe("custom")
    expect(normalizeWatcherName("./my-watcher.ts")).toBe("my-watcher")
  })

  test("handles paths without extensions", () => {
    expect(normalizeWatcherName("./watchers/my-watcher")).toBe("my-watcher")
  })

  test("handles relative paths with ..", () => {
    expect(normalizeWatcherName("../other/watcher.ts")).toBe("watcher")
  })
})

// ---------------------------------------------------------------------------
// parseDirective
// ---------------------------------------------------------------------------

describe("parseDirective", () => {
  test("parses a valid directive", () => {
    const result = parseDirective("##switchboard:cwd=.switchboard/workspaces/PROJ-123")
    expect(result).toEqual({ key: "cwd", value: ".switchboard/workspaces/PROJ-123" })
  })

  test("returns null for non-directive lines", () => {
    expect(parseDirective("just some output")).toBeNull()
    expect(parseDirective("")).toBeNull()
    expect(parseDirective("# comment")).toBeNull()
  })

  test("returns null for malformed directives (no =)", () => {
    expect(parseDirective("##switchboard:cwd")).toBeNull()
  })

  test("handles values with = signs", () => {
    const result = parseDirective("##switchboard:key=value=with=equals")
    expect(result).toEqual({ key: "key", value: "value=with=equals" })
  })

  test("handles empty value", () => {
    const result = parseDirective("##switchboard:key=")
    expect(result).toEqual({ key: "key", value: "" })
  })
})

// ---------------------------------------------------------------------------
// parseDirective
// ---------------------------------------------------------------------------

describe("parseDirective", () => {
  test("extracts cwd directive", () => {
    const d = parseDirective("##switchboard:cwd=.switchboard/workspaces/PROJ-123")
    expect(d).toEqual({ key: "cwd", value: ".switchboard/workspaces/PROJ-123" })
  })

  test("extracts arbitrary directive keys", () => {
    expect(parseDirective("##switchboard:pr_url=https://github.com/org/repo/pull/42"))
      .toEqual({ key: "pr_url", value: "https://github.com/org/repo/pull/42" })
    expect(parseDirective("##switchboard:custom_key=some_value"))
      .toEqual({ key: "custom_key", value: "some_value" })
  })

  test("returns null for non-directive lines", () => {
    expect(parseDirective("just regular output")).toBeNull()
    expect(parseDirective("")).toBeNull()
    expect(parseDirective("# a comment")).toBeNull()
  })

  test("returns null when no = sign", () => {
    expect(parseDirective("##switchboard:missing_equals")).toBeNull()
  })

  test("value can contain = signs", () => {
    const d = parseDirective("##switchboard:key=a=b=c")
    expect(d).toEqual({ key: "key", value: "a=b=c" })
  })
})

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  const task: Task = {
    id: "10001",
    identifier: "PROJ-123",
    title: "Fix login timeout",
    description: "The login form times out on slow connections",
    url: "https://jira.example.com/browse/PROJ-123",
    priority: 3,
  }

  test("renders task fields", () => {
    const template = "# {{task.identifier}}: {{task.title}}\n\n{{task.description}}"
    const result = renderTemplate(template, task, {})
    expect(result).toBe("# PROJ-123: Fix login timeout\n\nThe login form times out on slow connections")
  })

  test("renders env variables", () => {
    const template = "Token: {{env.MY_TOKEN}}"
    const result = renderTemplate(template, task, { MY_TOKEN: "secret-123" })
    expect(result).toBe("Token: secret-123")
  })

  test("falls back to task.id when identifier is missing", () => {
    const taskNoId: Task = { ...task, identifier: undefined }
    const template = "{{task.identifier}}"
    const result = renderTemplate(template, taskNoId, {})
    expect(result).toBe("10001")
  })

  test("renders null description as empty string", () => {
    const taskNullDesc: Task = { ...task, description: null }
    const template = "desc: {{task.description}}"
    const result = renderTemplate(template, taskNullDesc, {})
    expect(result).toBe("desc: ")
  })

  test("renders null url as empty string", () => {
    const taskNullUrl: Task = { ...task, url: null }
    const template = "url: {{task.url}}"
    const result = renderTemplate(template, taskNullUrl, {})
    expect(result).toBe("url: ")
  })

  test("renders null priority as empty string", () => {
    const taskNullPri: Task = { ...task, priority: null }
    const template = "pri: {{task.priority}}"
    const result = renderTemplate(template, taskNullPri, {})
    expect(result).toBe("pri: ")
  })

  test("renders priority as string", () => {
    const template = "pri: {{task.priority}}"
    const result = renderTemplate(template, task, {})
    expect(result).toBe("pri: 3")
  })
})

// ---------------------------------------------------------------------------
// Default script constants
// ---------------------------------------------------------------------------

describe("default scripts", () => {
  test("DEFAULT_INIT_SH is a non-empty string", () => {
    expect(typeof DEFAULT_INIT_SH).toBe("string")
    expect(DEFAULT_INIT_SH.length).toBeGreaterThan(0)
    expect(DEFAULT_INIT_SH).toContain("##switchboard:cwd=")
    expect(DEFAULT_INIT_SH).toContain("TASK_IDENTIFIER")
  })

  test("DEFAULT_TEARDOWN_SH is a non-empty string", () => {
    expect(typeof DEFAULT_TEARDOWN_SH).toBe("string")
    expect(DEFAULT_TEARDOWN_SH.length).toBeGreaterThan(0)
    expect(DEFAULT_TEARDOWN_SH).toContain("SWITCHBOARD_PROJECT_ROOT")
    expect(DEFAULT_TEARDOWN_SH).toContain("git worktree remove")
  })

  test("DEFAULT_AGENT_SH handles known agents", () => {
    expect(DEFAULT_AGENT_SH).toContain("opencode")
    expect(DEFAULT_AGENT_SH).toContain("claude")
    expect(DEFAULT_AGENT_SH).toContain("codex")
    expect(DEFAULT_AGENT_SH).toContain("copilot")
  })

  test("DEFAULT_WORK_MD is a Mustache template", () => {
    expect(DEFAULT_WORK_MD).toContain("{{task.identifier}}")
    expect(DEFAULT_WORK_MD).toContain("{{task.title}}")
    expect(DEFAULT_WORK_MD).toContain("{{task.description}}")
  })

  test("DEFAULT_TEARDOWN_MD is a Mustache template with PR instructions", () => {
    expect(DEFAULT_TEARDOWN_MD).toContain("{{task.identifier}}")
    expect(DEFAULT_TEARDOWN_MD).toContain("{{task.title}}")
    expect(DEFAULT_TEARDOWN_MD).toContain("##switchboard:pr_url=")
    expect(DEFAULT_TEARDOWN_MD).toContain("gh pr create")
    expect(DEFAULT_TEARDOWN_MD).toContain("git push")
  })
})

// ---------------------------------------------------------------------------
// createDispatcher (integration tests)
// ---------------------------------------------------------------------------

describe("createDispatcher", () => {
  const projectRoot = resolve(".tmp/dispatcher-test")
  const commandsDir = join(projectRoot, ".switchboard/commands")

  const task: Task = {
    id: "10001",
    identifier: "PROJ-123",
    title: "Fix login timeout",
    description: "The login form times out",
    url: "https://example.com/PROJ-123",
    priority: 3,
  }

  function makeConfig(overrides: Partial<SwitchboardConfig> = {}): SwitchboardConfig {
    return {
      waitBetweenPolls: 30_000,
      noTty: false,
      taskTtl: 3_600_000,
      watch: "test",
      agent: "echo",
      dispatch: join(projectRoot, ".switchboard/commands/"),
      concurrency: 4,
      ...overrides,
    }
  }

  beforeEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    mkdirSync(commandsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  test("runs init.sh, work.sh, and teardown.sh in order", async () => {
    // Create simple shell scripts that append to a log to prove ordering
    const orderLog = join(projectRoot, "order.log")

    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "init" >> "${orderLog}"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\necho "work" >> "${orderLog}"\n`
    )
    // No work.md -- skip agent step in work phase
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\necho "teardown" >> "${orderLog}"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    const log = readFileSync(orderLog, "utf-8").trim().split("\n")
    expect(log).toEqual(["init", "work", "teardown"])
  })

  test("handle.pid is set to a real subprocess PID", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\nsleep 0.1\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    // Wait briefly for the first subprocess to spawn
    await new Promise((r) => setTimeout(r, 50))

    // PID should be a positive integer once a subprocess has started
    expect(handle.pid).toBeGreaterThan(0)

    await handle.done
  })

  test("creates log directory and writes log files", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "init output"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\necho "work output"\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\necho "teardown output"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    // Check that log directory was created
    const logsBase = join(projectRoot, ".switchboard/logs/test/PROJ-123")
    expect(existsSync(logsBase)).toBe(true)

    // Find the dispatch ID directory
    const entries = readFileSync // actually readdir
    const { readdirSync } = await import("fs")
    const dispatchDirs = readdirSync(logsBase)
    expect(dispatchDirs).toHaveLength(1)

    const logDir = join(logsBase, dispatchDirs[0])
    const initLog = readFileSync(join(logDir, "init.sh.log"), "utf-8")
    expect(initLog).toContain("init output")

    const workLog = readFileSync(join(logDir, "work.sh.log"), "utf-8")
    expect(workLog).toContain("work output")

    const teardownLog = readFileSync(join(logDir, "teardown.sh.log"), "utf-8")
    expect(teardownLog).toContain("teardown output")
  })

  test("parses ##switchboard:cwd directive from init.sh", async () => {
    const workspace = join(projectRoot, "workspace")
    mkdirSync(workspace, { recursive: true })

    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "##switchboard:cwd=${workspace}"\n`
    )
    // work.sh writes its cwd to a file so we can verify
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\npwd > "${projectRoot}/actual-cwd.txt"\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    const actualCwd = readFileSync(join(projectRoot, "actual-cwd.txt"), "utf-8").trim()
    expect(actualCwd).toBe(workspace)
  })

  test("passes task fields as environment variables to shell scripts", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash
echo "TASK_ID=$TASK_ID" >> "${projectRoot}/env.log"
echo "TASK_IDENTIFIER=$TASK_IDENTIFIER" >> "${projectRoot}/env.log"
echo "TASK_TITLE=$TASK_TITLE" >> "${projectRoot}/env.log"
echo "TASK_DESCRIPTION=$TASK_DESCRIPTION" >> "${projectRoot}/env.log"
echo "TASK_URL=$TASK_URL" >> "${projectRoot}/env.log"
echo "TASK_PRIORITY=$TASK_PRIORITY" >> "${projectRoot}/env.log"
echo "SWITCHBOARD_PROJECT_ROOT=$SWITCHBOARD_PROJECT_ROOT" >> "${projectRoot}/env.log"
echo "SWITCHBOARD_WATCHER=$SWITCHBOARD_WATCHER" >> "${projectRoot}/env.log"
`
    )
    writeFileSync(join(commandsDir, "work.sh"), `#!/bin/bash\n# no-op\n`)
    writeFileSync(join(commandsDir, "teardown.sh"), `#!/bin/bash\n# no-op\n`)

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    const envLog = readFileSync(join(projectRoot, "env.log"), "utf-8")
    expect(envLog).toContain("TASK_ID=10001")
    expect(envLog).toContain("TASK_IDENTIFIER=PROJ-123")
    expect(envLog).toContain("TASK_TITLE=Fix login timeout")
    expect(envLog).toContain("TASK_DESCRIPTION=The login form times out")
    expect(envLog).toContain("TASK_URL=https://example.com/PROJ-123")
    expect(envLog).toContain("TASK_PRIORITY=3")
    expect(envLog).toContain(`SWITCHBOARD_PROJECT_ROOT=${projectRoot}`)
    expect(envLog).toContain("SWITCHBOARD_WATCHER=test")
  })

  test("teardown runs even when init fails", async () => {
    const orderLog = join(projectRoot, "order.log")

    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "init" >> "${orderLog}"\nexit 1\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\necho "work" >> "${orderLog}"\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\necho "teardown" >> "${orderLog}"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await expect(handle.done).rejects.toThrow()

    const log = readFileSync(orderLog, "utf-8").trim().split("\n")
    // work should be skipped, teardown should run
    expect(log).toEqual(["init", "teardown"])
  })

  test("teardown runs even when work fails", async () => {
    const orderLog = join(projectRoot, "order.log")

    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "init" >> "${orderLog}"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\necho "work" >> "${orderLog}"\nexit 1\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\necho "teardown" >> "${orderLog}"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await expect(handle.done).rejects.toThrow()

    const log = readFileSync(orderLog, "utf-8").trim().split("\n")
    expect(log).toEqual(["init", "work", "teardown"])
  })

  test("rejects with error when teardown fails", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\nexit 1\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await expect(handle.done).rejects.toThrow("teardown")
  })

  test("skips missing optional files", async () => {
    // Only provide work.sh -- no init, no teardown
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\n# empty\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\necho "work done"\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# empty\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done
    // Should complete without error
  })

  test("renders Mustache templates for agent steps", async () => {
    // Create a work.md that uses template variables
    writeFileSync(
      join(commandsDir, "work.md"),
      `# {{task.identifier}}: {{task.title}}\n\n{{task.description}}\n`
    )
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    // Create a custom agent.sh that just cats the prompt file for verification
    writeFileSync(
      join(commandsDir, "agent.sh"),
      `#!/bin/bash\ncat "$2"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    // Check the rendered prompt was written
    const { readdirSync } = await import("fs")
    const logsBase = join(projectRoot, ".switchboard/logs/test/PROJ-123")
    const dispatchDirs = readdirSync(logsBase)
    const logDir = join(logsBase, dispatchDirs[0])

    // The agent log should contain the rendered template
    const workLog = readFileSync(join(logDir, "work.md.log"), "utf-8")
    expect(workLog).toContain("PROJ-123: Fix login timeout")
    expect(workLog).toContain("The login form times out")
  })

  test("dispatch ID is 8 chars and passed to scripts", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "DISPATCH_ID=$SWITCHBOARD_DISPATCH_ID" > "${projectRoot}/dispatch-id.txt"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    const content = readFileSync(join(projectRoot, "dispatch-id.txt"), "utf-8")
    const match = content.match(/DISPATCH_ID=([0-9a-f]{8})/)
    expect(match).not.toBeNull()
  })

  test("init.sh always runs in project root", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\npwd > "${projectRoot}/init-cwd.txt"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    const initCwd = readFileSync(join(projectRoot, "init-cwd.txt"), "utf-8").trim()
    expect(initCwd).toBe(projectRoot)
  })

  test("collects ##switchboard: directives into handle.output", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "##switchboard:cwd=${projectRoot}"\necho "##switchboard:init_key=init_val"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\necho "##switchboard:work_key=work_val"\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\necho "##switchboard:pr_url=https://github.com/org/repo/pull/1"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    expect(handle.output.cwd).toBe(projectRoot)
    expect(handle.output.init_key).toBe("init_val")
    expect(handle.output.work_key).toBe("work_val")
    expect(handle.output.pr_url).toBe("https://github.com/org/repo/pull/1")
  })

  test("handle.output is available even when dispatch fails", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "##switchboard:init_key=before_fail"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\necho "##switchboard:work_key=partial"\nexit 1\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await expect(handle.done).rejects.toThrow()

    // Directives from steps that ran before the failure are still collected
    expect(handle.output.init_key).toBe("before_fail")
    expect(handle.output.work_key).toBe("partial")
  })

  test("passes SWITCHBOARD_LOG_DIR to shell scripts", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\necho "LOG_DIR=$SWITCHBOARD_LOG_DIR" > "${projectRoot}/log-dir.txt"\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    const content = readFileSync(join(projectRoot, "log-dir.txt"), "utf-8")
    expect(content).toContain("LOG_DIR=")
    expect(content).toContain(".switchboard/logs/")
    // Should not be empty
    expect(content).not.toBe("LOG_DIR=\n")
  })

  test("collects directives from agent steps via agent.sh stdout", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    // Create a teardown.md that uses template variables
    writeFileSync(
      join(commandsDir, "teardown.md"),
      `Print the PR URL for {{task.identifier}}\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    // Agent script that echoes a directive
    writeFileSync(
      join(commandsDir, "agent.sh"),
      `#!/bin/bash\necho "##switchboard:pr_url=https://github.com/org/repo/pull/99"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    expect(handle.output.pr_url).toBe("https://github.com/org/repo/pull/99")
  })

  test("skips teardown agent when user provides empty teardown.md", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "work.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(join(commandsDir, "work.md"), "\n")
    writeFileSync(join(commandsDir, "teardown.md"), "\n")
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\necho "teardown shell" > "${projectRoot}/teardown-shell.txt"\n`
    )
    writeFileSync(
      join(commandsDir, "agent.sh"),
      `#!/bin/bash\necho "agent invoked" > "${projectRoot}/agent-invoked.txt"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    expect(existsSync(join(projectRoot, "agent-invoked.txt"))).toBe(false)
    expect(readFileSync(join(projectRoot, "teardown-shell.txt"), "utf-8").trim()).toBe("teardown shell")
  })

  test("skips default work agent when user provides empty work.md", async () => {
    writeFileSync(
      join(commandsDir, "init.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(
      join(commandsDir, "teardown.sh"),
      `#!/bin/bash\n# no-op\n`
    )
    writeFileSync(join(commandsDir, "work.md"), "   \n\t\n")
    writeFileSync(join(commandsDir, "teardown.md"), "\n")
    writeFileSync(
      join(commandsDir, "agent.sh"),
      `#!/bin/bash\necho "agent invoked" > "${projectRoot}/agent-invoked.txt"\n`
    )

    const config = makeConfig()
    const dispatch = createDispatcher({ config, projectRoot })
    const handle = dispatch(task, "a1b2c3d4")

    await handle.done

    expect(existsSync(join(projectRoot, "agent-invoked.txt"))).toBe(false)
  })

  test("uses default init.sh when no user-defined init.sh exists", async () => {
    // Use a project root outside any git repo so default init.sh
    // falls back to working directly in the project root.
    const isolatedRoot = join("/tmp", `switchboard-test-${crypto.randomUUID().slice(0, 8)}`)
    const isolatedCommandsDir = join(isolatedRoot, ".switchboard/commands")
    mkdirSync(isolatedRoot, { recursive: true })

    try {
      // Do NOT create commandsDir — defaults should be used
      const config = makeConfig({ dispatch: isolatedCommandsDir })
      const dispatch = createDispatcher({ config, projectRoot: isolatedRoot })
      const handle = dispatch(task, "a1b2c3d4")

      await expect(handle.done).resolves.toEqual([
        { name: "init.sh", exitCode: 0 },
        { name: "work.md", exitCode: 0 },
        { name: "teardown.md", exitCode: 0 },
        { name: "teardown.sh", exitCode: 0 },
      ])
      expect(handle.output.cwd).toBe(isolatedRoot)
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true })
    }
  })

  test("uses default init and teardown when git command is unavailable", async () => {
    const isolatedRoot = join("/tmp", `switchboard-test-${crypto.randomUUID().slice(0, 8)}`)
    const isolatedCommandsDir = join(isolatedRoot, ".switchboard/commands")
    mkdirSync(isolatedRoot, { recursive: true })

    const originalPath = process.env.PATH
    process.env.PATH = ""

    try {
      const config = makeConfig({ dispatch: isolatedCommandsDir })
      const dispatch = createDispatcher({ config, projectRoot: isolatedRoot })
      const handle = dispatch(task, "a1b2c3d4")

      await expect(handle.done).resolves.toEqual([
        { name: "init.sh", exitCode: 0 },
        { name: "work.md", exitCode: 0 },
        { name: "teardown.md", exitCode: 0 },
        { name: "teardown.sh", exitCode: 0 },
      ])
      expect(handle.output.cwd).toBe(isolatedRoot)
    } finally {
      process.env.PATH = originalPath
      rmSync(isolatedRoot, { recursive: true, force: true })
    }
  })
})
