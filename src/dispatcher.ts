import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs"
import { resolve, basename, extname, join } from "path"
import Mustache from "mustache"
import type { Dispatcher, DispatchHandle, StepResult, SwitchboardConfig, Task } from "./types"

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

# Clean up any stale worktree references (e.g. a previous run's directory
# was removed but the git worktree entry was never pruned).
git worktree prune

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
git worktree remove --force "$WORKSPACE"
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
  dummy)
    # No-cost test agent that sleeps for a random duration.
    # Configure with DUMMY_SLEEP_DURATION="2s-10s" (default 4s-15s).
    # Supports s (seconds), m (minutes), h (hours) suffixes.
    _to_sec() {
      local _v="\${1%[smh]}"
      case "$1" in
        *h) echo $(( _v * 3600 )) ;;
        *m) echo $(( _v * 60 )) ;;
        *)  echo $(( _v )) ;;
      esac
    }
    _dur="\${DUMMY_SLEEP_DURATION:-4s-15s}"
    _min=$(_to_sec "\${_dur%-*}")
    _max=$(_to_sec "\${_dur#*-}")
    sleep $(( RANDOM % (_max - _min + 1) + _min ))
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

export const DEFAULT_TEARDOWN_MD = `# Teardown: {{task.identifier}}: {{task.title}}

You are reviewing completed work for this task. Your job is to determine if the
work is ready for human review and, if so, open a pull request.

## Instructions

1. Review the changes on the current branch using \`git log\` and \`git diff main\`
   to understand what was accomplished.

2. If there are meaningful commits that would benefit from human review — even if
   the work is not fully complete — open a pull request:

   a. Push the branch to the remote:
      \`\`\`
      git push -u origin "switchboard/{{task.identifier}}"
      \`\`\`

   b. Create a pull request with a clear, descriptive summary of the changes:
      \`\`\`
      gh pr create \\
        --title "{{task.identifier}}: {{task.title}}" \\
        --body "<description of changes>" \\
        --base main
      \`\`\`

   c. After creating the PR, include the following directive on its own line in
      your response (this is how Switchboard captures the PR URL):
      \`\`\`
      ##switchboard:pr_url=<the PR URL>
      \`\`\`

3. If there are no meaningful changes (e.g., the branch has no new commits ahead
   of main), skip PR creation.
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
  logDir: string,
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
    SWITCHBOARD_LOG_DIR: logDir,
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
    "teardown.md": readIfExists("teardown.md") ?? DEFAULT_TEARDOWN_MD,
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
  onPid: (pid: number) => void
  onDirective: (key: string, value: string) => void
}

/**
 * Run a single lifecycle step. The step type is inferred from the file
 * extension in `stepName`:
 *
 *  - `.sh` — the content is executed directly as a bash script.
 *  - `.md` — the content is treated as a Mustache template, rendered with
 *            task context, written to a temp file, and passed to agent.sh.
 *
 * In both cases stdout is streamed through a line scanner to detect
 * ##switchboard: directives in real time, and all output is logged.
 * Throws on non-zero exit.
 */
async function runStep(
  content: string,
  stepName: string,
  ctx: StepContext,
): Promise<void> {
  const ext = extname(stepName)

  // Build the command to spawn based on file extension
  let spawnArgs: string[]
  if (ext === ".md") {
    // Render Mustache template and write to a temp file
    const rendered = renderTemplate(content, ctx.task, process.env as Record<string, string | undefined>)
    const promptDir = join(ctx.logDir, ".prompts")
    mkdirSync(promptDir, { recursive: true })
    const promptPath = join(promptDir, stepName)
    await Bun.write(promptPath, rendered)

    // Write agent.sh to a temp file and invoke it with the prompt
    const agentScriptPath = join(promptDir, "agent.sh")
    await Bun.write(agentScriptPath, ctx.agentScript)

    spawnArgs = ["bash", "-lc", `bash "${agentScriptPath}" "${ctx.agent}" "${promptPath}"`]
  } else {
    // .sh — run the script content directly
    spawnArgs = ["bash", "-lc", content]
  }

  const env = {
    ...process.env,
    ...buildTaskEnv(ctx.task, ctx.projectRoot, ctx.dispatchId, ctx.watcherName, ctx.logDir),
  }

  const logPath = join(ctx.logDir, `${stepName}.log`)
  const logFile = Bun.file(logPath)
  const logWriter = logFile.writer()

  const proc = Bun.spawn(spawnArgs, {
    cwd: ctx.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  ctx.onPid(proc.pid)

  const readStdout = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let partial = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        logWriter.write(value)
        partial += decoder.decode(value, { stream: true })
        const lines = partial.split("\n")
        // Last element is the incomplete line (or "" if chunk ended on \n)
        partial = lines.pop()!
        for (const line of lines) {
          const d = parseDirective(line.trim())
          if (d) ctx.onDirective(d.key, d.value)
        }
      }
    }
    // Flush any remaining partial line
    if (partial) {
      const d = parseDirective(partial.trim())
      if (d) ctx.onDirective(d.key, d.value)
    }
  }

  const readStderr = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) logWriter.write(value)
    }
  }

  await Promise.all([
    readStdout(proc.stdout as ReadableStream<Uint8Array>),
    readStderr(proc.stderr as ReadableStream<Uint8Array>),
  ])

  await logWriter.flush()
  logWriter.end()

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${stepName} exited with code ${exitCode}`)
  }
}

// ---------------------------------------------------------------------------
// Exit code extraction
// ---------------------------------------------------------------------------

/**
 * Extract a numeric exit code from an error thrown by runStep.
 * Falls back to 1 if the code cannot be determined.
 */
function extractExitCode(err: unknown): number {
  if (err instanceof Error) {
    const match = err.message.match(/exited with code (\d+)/)
    if (match) return parseInt(match[1], 10)
  }
  return 1
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

  return (task: Task, dispatchId: string): DispatchHandle => {
    const identifier = task.identifier ?? task.id
    const logDir = join(root, ".switchboard/logs", watcherName, identifier, dispatchId)
    mkdirSync(logDir, { recursive: true })

    // We need a PID to return synchronously but we don't have one yet.
    // Use a mutable handle that we update as subprocesses start.
    let currentPid = 0
    const output: Record<string, string> = {}

    const done = runLifecycle(task, commands, {
      projectRoot: root,
      dispatchId,
      watcherName,
      agent: config.agent,
      logDir,
    })

    return {
      get pid() { return currentPid },
      dispatchId,
      logDir,
      output,
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
    ): Promise<StepResult[]> {
      let cwd = opts.projectRoot
      let initFailed = false
      let workFailed = false
      const steps: StepResult[] = []

      const onDirective = (key: string, value: string) => {
        output[key] = value
        if (key === "cwd") {
          cwd = resolve(opts.projectRoot, value)
        }
      }

      const makeCtx = (): StepContext => ({
        task,
        projectRoot: opts.projectRoot,
        cwd,
        dispatchId: opts.dispatchId,
        watcherName: opts.watcherName,
        agent: opts.agent,
        agentScript: commands["agent.sh"],
        logDir: opts.logDir,
        onPid: (pid: number) => { currentPid = pid },
        onDirective,
      })

      // --- Init phase ---
      try {
        // init.sh
        if (commands["init.sh"]) {
          // init.sh always runs in project root
          const ctx = makeCtx()
          ctx.cwd = opts.projectRoot
          await runStep(commands["init.sh"], "init.sh", ctx)
          steps.push({ name: "init.sh", exitCode: 0 })
        }

        // init.md
        if (commands["init.md"]) {
          await runStep(commands["init.md"], "init.md", makeCtx())
          steps.push({ name: "init.md", exitCode: 0 })
        }
      } catch (err) {
        const exitCode = extractExitCode(err)
        const lastStepName = commands["init.md"] ? "init.md" : "init.sh"
        steps.push({ name: lastStepName, exitCode })
        initFailed = true
      }

      // --- Work phase (skip if init failed) ---
      if (!initFailed) {
        try {
          // work.sh
          if (commands["work.sh"]) {
            await runStep(commands["work.sh"], "work.sh", makeCtx())
            steps.push({ name: "work.sh", exitCode: 0 })
          }

          // work.md
          if (commands["work.md"]) {
            await runStep(commands["work.md"], "work.md", makeCtx())
            steps.push({ name: "work.md", exitCode: 0 })
          }
        } catch (err) {
          const exitCode = extractExitCode(err)
          const lastStepName = commands["work.md"] ? "work.md" : "work.sh"
          steps.push({ name: lastStepName, exitCode })
          workFailed = true
        }
      }

      // --- Teardown phase (always runs) ---
      let teardownFailed = false
      try {
        // teardown.md (agent goes first in teardown)
        if (commands["teardown.md"]) {
          await runStep(commands["teardown.md"], "teardown.md", makeCtx())
          steps.push({ name: "teardown.md", exitCode: 0 })
        }

        // teardown.sh
        if (commands["teardown.sh"]) {
          await runStep(commands["teardown.sh"], "teardown.sh", makeCtx())
          steps.push({ name: "teardown.sh", exitCode: 0 })
        }
      } catch (err) {
        const exitCode = extractExitCode(err)
        const lastStepName = commands["teardown.sh"] ? "teardown.sh" : "teardown.md"
        steps.push({ name: lastStepName, exitCode })
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

      return steps
    }
  }
}
