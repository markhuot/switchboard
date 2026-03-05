import { mkdirSync, existsSync, readFileSync } from "fs"
import { resolve, basename, extname, join } from "path"
import Mustache from "mustache"
import type { Dispatcher, DispatchHandle, SwitchboardConfig, Task } from "./types"

// ---------------------------------------------------------------------------
// Default scripts inlined as string constants
// ---------------------------------------------------------------------------

export const DEFAULT_INIT_SH = `#!/bin/bash
set -euo pipefail

WORKSPACE=".switchboard/workspaces/$TASK_IDENTIFIER"

# If the workspace directory already exists, assume a previous attempt
# failed partway through. Reuse it and pick up where we left off.
if [ -d "$WORKSPACE" ]; then
  echo "##switchboard:cwd=$WORKSPACE"
  exit 0
fi

# If the branch already exists, create a worktree from it (continuing
# previous work). Otherwise create a fresh branch.
if git show-ref --verify --quiet "refs/heads/switchboard/$TASK_IDENTIFIER"; then
  git worktree add "$WORKSPACE" "switchboard/$TASK_IDENTIFIER"
else
  git worktree add "$WORKSPACE" -b "switchboard/$TASK_IDENTIFIER"
fi

echo "##switchboard:cwd=$WORKSPACE"
`

export const DEFAULT_TEARDOWN_SH = `#!/bin/bash
set -euo pipefail

# Reconstruct the workspace path from the task identifier rather than
# relying on $(pwd). If init failed partway through, teardown may still
# be running in the project root -- $(pwd) would point at the wrong place.
WORKSPACE="$SWITCHBOARD_PROJECT_ROOT/.switchboard/workspaces/$TASK_IDENTIFIER"

# If the workspace directory does not exist, init never got far enough to
# create it (or it was never needed). Nothing to clean up.
if [ ! -d "$WORKSPACE" ]; then
  exit 0
fi

cd "$SWITCHBOARD_PROJECT_ROOT"
git worktree remove "$WORKSPACE"
`

export const DEFAULT_AGENT_SH = `#!/bin/bash
set -euo pipefail

AGENT="$1"
PROMPT_FILE="$2"

case "$AGENT" in
  opencode)
    opencode run "$(cat "$PROMPT_FILE")"
    ;;
  claude)
    claude -p "$(cat "$PROMPT_FILE")" --print
    ;;
  codex)
    codex --prompt "$(cat "$PROMPT_FILE")"
    ;;
  copilot)
    gh copilot --prompt "$(cat "$PROMPT_FILE")"
    ;;
  *)
    # Unknown agent -- treat the value as a command and pass the prompt
    # file as the first argument. This supports --agent=./my-agent.
    "$AGENT" "$PROMPT_FILE"
    ;;
esac
`

export const DEFAULT_WORK_MD = `# {{task.identifier}}: {{task.title}}

{{task.description}}

Work on this task until it is complete.
`

// ---------------------------------------------------------------------------
// Dispatch ID generation
// ---------------------------------------------------------------------------

export function generateDispatchId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8)
}

// ---------------------------------------------------------------------------
// Watcher name normalization for log paths
// ---------------------------------------------------------------------------

export function normalizeWatcherName(watch: string): string {
  // Shell mode (starts with "$ ")
  if (watch.startsWith("$ ")) return "shell"
  // File path (contains "/" or starts with ".")
  if (watch.includes("/") || watch.startsWith(".")) {
    const base = basename(watch)
    const ext = extname(base)
    return ext ? base.slice(0, -ext.length) : base
  }
  // Built-in name
  return watch
}

// ---------------------------------------------------------------------------
// ##switchboard: directive parsing
// ---------------------------------------------------------------------------

export interface ParsedDirectives {
  cwd?: string
}

/**
 * Parse ##switchboard: directives from a line of stdout.
 * Returns the directive key/value if the line is a directive, or null otherwise.
 */
export function parseDirective(line: string): { key: string; value: string } | null {
  const prefix = "##switchboard:"
  if (!line.startsWith(prefix)) return null
  const rest = line.slice(prefix.length)
  const eqIndex = rest.indexOf("=")
  if (eqIndex === -1) return null
  return { key: rest.slice(0, eqIndex), value: rest.slice(eqIndex + 1) }
}

/**
 * Scan stdout text line-by-line for ##switchboard: directives.
 * Returns the accumulated directives (last value wins for each key).
 */
export function extractDirectives(stdout: string): ParsedDirectives {
  const directives: ParsedDirectives = {}
  for (const line of stdout.split("\n")) {
    const d = parseDirective(line.trim())
    if (d && d.key === "cwd") {
      directives.cwd = d.value
    }
  }
  return directives
}

// ---------------------------------------------------------------------------
// Mustache template rendering
// ---------------------------------------------------------------------------

export function renderTemplate(template: string, task: Task, env: Record<string, string | undefined>): string {
  const context = {
    task: {
      id: task.id,
      identifier: task.identifier ?? task.id,
      title: task.title,
      description: task.description ?? "",
      url: task.url ?? "",
      priority: task.priority != null ? String(task.priority) : "",
    },
    env,
  }
  return Mustache.render(template, context)
}

// ---------------------------------------------------------------------------
// Task environment variables
// ---------------------------------------------------------------------------

function buildTaskEnv(
  task: Task,
  projectRoot: string,
  dispatchId: string,
  watcherName: string,
): Record<string, string> {
  return {
    TASK_ID: task.id,
    TASK_IDENTIFIER: task.identifier ?? task.id,
    TASK_TITLE: task.title,
    TASK_DESCRIPTION: task.description ?? "",
    TASK_URL: task.url ?? "",
    TASK_PRIORITY: task.priority != null ? String(task.priority) : "",
    SWITCHBOARD_PROJECT_ROOT: projectRoot,
    SWITCHBOARD_DISPATCH_ID: dispatchId,
    SWITCHBOARD_WATCHER: watcherName,
  }
}

// ---------------------------------------------------------------------------
// Commands directory resolution
// ---------------------------------------------------------------------------

interface ResolvedCommands {
  "init.sh": string | null
  "init.md": string | null
  "work.sh": string | null
  "work.md": string | null
  "teardown.md": string | null
  "teardown.sh": string | null
  "agent.sh": string
}

type CommandFile = keyof ResolvedCommands

function resolveCommands(commandsDir: string, projectRoot: string): ResolvedCommands {
  const absDir = resolve(projectRoot, commandsDir)

  function readIfExists(filename: string): string | null {
    const filepath = join(absDir, filename)
    if (existsSync(filepath)) {
      return readFileSync(filepath, "utf-8")
    }
    return null
  }

  return {
    "init.sh": readIfExists("init.sh") ?? DEFAULT_INIT_SH,
    "init.md": readIfExists("init.md"),
    "work.sh": readIfExists("work.sh"),
    "work.md": readIfExists("work.md") ?? DEFAULT_WORK_MD,
    "teardown.md": readIfExists("teardown.md"),
    "teardown.sh": readIfExists("teardown.sh") ?? DEFAULT_TEARDOWN_SH,
    "agent.sh": readIfExists("agent.sh") ?? DEFAULT_AGENT_SH,
  }
}

// ---------------------------------------------------------------------------
// Step execution helpers
// ---------------------------------------------------------------------------

interface StepContext {
  task: Task
  projectRoot: string
  cwd: string
  dispatchId: string
  watcherName: string
  agent: string
  agentScript: string
  logDir: string
}

/**
 * Run a shell script step. Returns the stdout text so directives can be parsed.
 * Throws on non-zero exit.
 */
async function runShellStep(
  script: string,
  stepName: string,
  ctx: StepContext,
): Promise<string> {
  const env = {
    ...process.env,
    ...buildTaskEnv(ctx.task, ctx.projectRoot, ctx.dispatchId, ctx.watcherName),
  }

  const logPath = join(ctx.logDir, `${stepName}.log`)
  const logFile = Bun.file(logPath)
  const logWriter = logFile.writer()

  const proc = Bun.spawn(["bash", "-lc", script], {
    cwd: ctx.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  // Capture stdout for directive parsing and logging
  const stdoutChunks: Uint8Array[] = []
  const readStream = async (stream: ReadableStream<Uint8Array>, label?: string) => {
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        if (label === "stdout") stdoutChunks.push(new Uint8Array(value))
        logWriter.write(value)
      }
    }
  }

  await Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
    readStream(proc.stderr as ReadableStream<Uint8Array>),
  ])

  await logWriter.flush()
  logWriter.end()

  const exitCode = await proc.exited
  const totalLength = stdoutChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of stdoutChunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  const stdoutText = new TextDecoder().decode(combined)

  if (exitCode !== 0) {
    throw new Error(`${stepName} exited with code ${exitCode}`)
  }

  return stdoutText
}

/**
 * Run an agent (`.md`) step. Renders the Mustache template, writes it to
 * a temp file, and invokes agent.sh with it.
 * Throws on non-zero exit.
 */
async function runAgentStep(
  template: string,
  stepName: string,
  ctx: StepContext,
): Promise<void> {
  const rendered = renderTemplate(template, ctx.task, process.env as Record<string, string | undefined>)

  // Write rendered prompt to a temp file
  const promptDir = join(ctx.logDir, ".prompts")
  mkdirSync(promptDir, { recursive: true })
  const promptPath = join(promptDir, `${stepName}`)
  await Bun.write(promptPath, rendered)

  const env = {
    ...process.env,
    ...buildTaskEnv(ctx.task, ctx.projectRoot, ctx.dispatchId, ctx.watcherName),
  }

  const logPath = join(ctx.logDir, `${stepName}.log`)
  const logFile = Bun.file(logPath)
  const logWriter = logFile.writer()

  // Write the agent.sh to a temp file and invoke it
  const agentScriptPath = join(promptDir, "agent.sh")
  await Bun.write(agentScriptPath, ctx.agentScript)

  const proc = Bun.spawn(["bash", "-lc", `bash "${agentScriptPath}" "${ctx.agent}" "${promptPath}"`], {
    cwd: ctx.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        logWriter.write(value)
      }
    }
  }

  await Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>),
    readStream(proc.stderr as ReadableStream<Uint8Array>),
  ])

  await logWriter.flush()
  logWriter.end()

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${stepName} agent exited with code ${exitCode}`)
  }
}

// ---------------------------------------------------------------------------
// createDispatcher factory
// ---------------------------------------------------------------------------

export interface DispatcherConfig {
  config: SwitchboardConfig
  projectRoot?: string
}

export function createDispatcher({ config, projectRoot }: DispatcherConfig): Dispatcher {
  const root = projectRoot ?? process.cwd()
  const watcherName = normalizeWatcherName(config.watch)
  const commands = resolveCommands(config.dispatch, root)

  return (task: Task): DispatchHandle => {
    const dispatchId = generateDispatchId()
    const identifier = task.identifier ?? task.id
    const logDir = join(root, ".switchboard/logs", watcherName, identifier, dispatchId)
    mkdirSync(logDir, { recursive: true })

    // We need a PID to return synchronously but we don't have one yet.
    // Use a mutable handle that we update as subprocesses start.
    let currentPid = 0

    const done = runLifecycle(task, commands, {
      projectRoot: root,
      dispatchId,
      watcherName,
      agent: config.agent,
      logDir,
    })

    return {
      get pid() { return currentPid },
      done,
    }

    async function runLifecycle(
      task: Task,
      commands: ResolvedCommands,
      opts: {
        projectRoot: string
        dispatchId: string
        watcherName: string
        agent: string
        logDir: string
      },
    ): Promise<void> {
      let cwd = opts.projectRoot
      let initFailed = false
      let workFailed = false

      const makeCtx = (): StepContext => ({
        task,
        projectRoot: opts.projectRoot,
        cwd,
        dispatchId: opts.dispatchId,
        watcherName: opts.watcherName,
        agent: opts.agent,
        agentScript: commands["agent.sh"],
        logDir: opts.logDir,
      })

      // --- Init phase ---
      try {
        // init.sh
        if (commands["init.sh"]) {
          // init.sh always runs in project root
          const ctx = makeCtx()
          ctx.cwd = opts.projectRoot
          const stdout = await runShellStep(commands["init.sh"], "init.sh", ctx)
          const directives = extractDirectives(stdout)
          if (directives.cwd) {
            cwd = resolve(opts.projectRoot, directives.cwd)
          }
        }

        // init.md
        if (commands["init.md"]) {
          await runAgentStep(commands["init.md"], "init.md", makeCtx())
        }
      } catch {
        initFailed = true
      }

      // --- Work phase (skip if init failed) ---
      if (!initFailed) {
        try {
          // work.sh
          if (commands["work.sh"]) {
            await runShellStep(commands["work.sh"], "work.sh", makeCtx())
          }

          // work.md
          if (commands["work.md"]) {
            await runAgentStep(commands["work.md"], "work.md", makeCtx())
          }
        } catch {
          workFailed = true
        }
      }

      // --- Teardown phase (always runs) ---
      let teardownFailed = false
      try {
        // teardown.md (agent goes first in teardown)
        if (commands["teardown.md"]) {
          await runAgentStep(commands["teardown.md"], "teardown.md", makeCtx())
        }

        // teardown.sh
        if (commands["teardown.sh"]) {
          await runShellStep(commands["teardown.sh"], "teardown.sh", makeCtx())
        }
      } catch {
        teardownFailed = true
      }

      // Determine final status
      if (initFailed || workFailed || teardownFailed) {
        throw new Error(
          `Dispatch failed: ${[
            initFailed && "init",
            workFailed && "work",
            teardownFailed && "teardown",
          ].filter(Boolean).join(", ")}`,
        )
      }
    }
  }
}
