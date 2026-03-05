# Dispatcher Specification

Status: Ready to Implement

## Overview

The **dispatcher** is the component that takes a claimed task and runs it through a lifecycle: prepare a workspace, do the work, clean up. Each phase of the lifecycle is defined by convention files in a commands directory. A `.sh` file is executed as a shell script. A `.md` file is sent to an agent as a prompt. The dispatcher is the bridge between "the orchestrator has a task" and "an agent is working on it."

This replaces the stub `dispatch()` that currently spawns `sleep`.

## Lifecycle

Every dispatched task moves through three phases in order:

```
init  →  work  →  teardown
```

**Init** prepares the environment. Create a workspace, check out a branch, install dependencies. This is setup that must succeed before an agent touches anything.

**Work** is the actual task. An agent receives a prompt describing what to do and operates in whatever environment init prepared.

**Teardown** cleans up. Push a branch, open a PR, delete the workspace, post a comment back to the task source. **Teardown always runs**, even if init or work failed. It is the `finally` block. Switchboard does not manage workspaces directly -- teardown is responsible for any cleanup, including removing workspace directories. If teardown is absent or incomplete, resources are leaked.

## Commands Directory

The dispatcher looks for lifecycle files in `.switchboard/commands/` relative to the project root. It can be overridden:

```
switchboard --watch=jira --agent=opencode --dispatch=./my-pipeline/
```

The directory may contain any combination of these files:

```
.switchboard/
  commands/
    init.sh          # shell: runs first during init
    init.md          # agent: runs second during init
    work.sh          # shell: runs first during work
    work.md          # agent: runs second during work
    teardown.md      # agent: runs first during teardown
    teardown.sh      # shell: runs last during teardown
    agent.sh         # shell: agent invocation adapter
```

All files are optional. Switchboard ships a default `work.md` (see below), so the dispatcher always has something to run even if no user-defined files exist.

### Execution order

Within each phase, `.sh` runs before `.md`. Both may be present.

```
1. init.sh         # shell: create workspace, clone, install
2. init.md         # agent: orient, read codebase, plan
3. work.sh         # shell: environment prep, pre-work scripting
4. work.md         # agent: do the task
5. teardown.md     # agent: self-review, write summary
6. teardown.sh     # shell: push, open PR, delete workspace
```

For init and work, the shell script sets up the environment before the agent operates in it. For teardown, the agent goes first so it can stage files, write commit messages, or finalize work before a shell script pushes the result and cleans up.

If only one file exists for a phase (e.g., just `work.md` with no `work.sh`), the other is simply skipped.

## Workspace

Switchboard does **not** create or manage workspace directories. That is init's job.

If no init files exist (and no default init runs), all steps execute in the project root -- the `cwd` where Switchboard was launched. This is valid for simple setups where the agent works directly in the main project.

### Workspace path communication

When init creates a workspace, it needs to tell Switchboard where subsequent steps should run. It does this through **stdout directives**.

Shell scripts can emit structured directives on stdout using a `##switchboard:` prefix, inspired by [GitHub Actions workflow commands](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions). Switchboard scans stdout line-by-line for these directives, extracts them, and passes all other output through to logging as normal.

To set the working directory for subsequent steps:

```
##switchboard:cwd=.switchboard/workspaces/PROJ-123
```

**Path resolution:** Relative paths are resolved against the project root (where Switchboard was launched). Absolute paths are used as-is. If a script emits multiple `##switchboard:cwd=` directives, the **last one wins** -- earlier values are overwritten.

Switchboard uses this path as the `cwd` for all subsequent steps (`init.md`, `work.sh`, `work.md`, `teardown.md`, `teardown.sh`). If no `##switchboard:cwd=` directive is emitted, all steps continue in the project root.

This approach is robust against noisy scripts. Tools that print banners, progress bars, or status messages to stdout do not interfere -- only lines matching the `##switchboard:` prefix are interpreted. Scripts do not need to carefully silence all output or redirect to stderr.

The directive format is extensible. If Switchboard needs to read other signals from scripts in the future, new keys follow the same pattern (`##switchboard:key=value`).

`init.sh` itself always runs in the project root because the workspace does not yet exist.

### Default init script

Switchboard ships a built-in default `init.sh`, inlined in the TypeScript source as a string literal. It creates a [git worktree](https://git-scm.com/docs/git-worktree) and prints its path:

```bash
#!/bin/bash
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
```

This default runs when no `.switchboard/commands/init.sh` exists in the project. It gives each task an isolated copy of the repository on its own branch, without a full clone. If the task was previously attempted (branch or workspace already exists), it reuses what is there so work can continue.

To override the default, create a project-specific `.switchboard/commands/init.sh`. To opt out of workspace creation entirely (work in the project root), create an empty file:

```bash
#!/bin/bash
# No workspace needed -- work happens in the project root.
```

No `##switchboard:cwd=` directive means Switchboard stays in the project root.

### Default teardown script

Switchboard ships a built-in default `teardown.sh` that cleans up the worktree created by the default init:

```bash
#!/bin/bash
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
```

Same override rules apply. If the project provides `.switchboard/commands/teardown.sh`, it replaces the default. An empty file opts out of cleanup.

## Task Data

Lifecycle steps need access to task fields. Shell scripts and agent prompts receive this data through different mechanisms.

### Shell scripts

Shell scripts receive task fields as environment variables. All values are strings. Null fields are empty strings.

| Variable | Source |
|---|---|
| `TASK_ID` | `task.id` |
| `TASK_IDENTIFIER` | `task.identifier` (falls back to `task.id`) |
| `TASK_TITLE` | `task.title` |
| `TASK_DESCRIPTION` | `task.description` |
| `TASK_URL` | `task.url` |
| `TASK_PRIORITY` | `task.priority` (stringified integer) |
| `SWITCHBOARD_PROJECT_ROOT` | Absolute path to the project root (where Switchboard was launched) |
| `SWITCHBOARD_DISPATCH_ID` | 8-character dispatch ID for this attempt |
| `SWITCHBOARD_WATCHER` | The `--watch` value (e.g., `jira`, `./my-watcher.ts`) |

Scripts inherit the parent process environment, so any existing variables (`GITHUB_TOKEN`, `JIRA_TOKEN`, etc.) are available without extra wiring.

Shell scripts are executed via `Bun.spawn(["bash", "-lc", script])`, consistent with the shell watcher. The `-l` flag loads the user's shell profile so tools like `gh`, `npm`, and `git` are on the PATH.

### Agent prompts (`.md` files)

Markdown files are rendered as [Mustache](https://mustache.github.io/) templates before being sent to the agent. Mustache is a published, language-agnostic template spec -- logic-less, widely supported, and not something we are inventing.

```markdown
# Task: {{task.identifier}}

{{task.title}}

## Description

{{task.description}}

## Instructions

You are working in a git repository. The branch `switchboard/{{task.identifier}}`
has been created for you. Make your changes and commit them.
```

The template context contains two objects:

**`task` -- the task fields:**

| Variable | Source |
|---|---|
| `{{task.id}}` | `task.id` |
| `{{task.identifier}}` | `task.identifier` (falls back to `task.id`) |
| `{{task.title}}` | `task.title` |
| `{{task.description}}` | `task.description` (empty string if null) |
| `{{task.url}}` | `task.url` (empty string if null) |
| `{{task.priority}}` | `task.priority` (empty string if null) |

**`env` -- the full process environment:**

| Variable | Source |
|---|---|
| `{{env.GITHUB_TOKEN}}` | `process.env.GITHUB_TOKEN` |
| `{{env.JIRA_TOKEN}}` | `process.env.JIRA_TOKEN` |
| ... | any environment variable |

Exposing `env` in templates means prompts can reference tokens, URLs, or project-specific settings without Switchboard needing to know about them.

### Future consideration: richer templates

Mustache is deliberately logic-less. If teams eventually need conditionals, helpers, or composable components in their prompts, [Handlebars](https://handlebarsjs.com/) is a natural upgrade. It extends Mustache syntax with helpers (`{{env "GITHUB_TOKEN"}}`, `{{file "README.md"}}`) and block expressions. The migration path is clean since all valid Mustache is valid Handlebars.

## Agent Execution

When the dispatcher encounters a `.md` file, it renders the Mustache template, writes the result to a temporary file, and invokes an **agent script** to run it.

### agent.sh

Rather than Switchboard knowing how to invoke every coding agent, it delegates to an `agent.sh` script. This script receives the agent name (from `--agent`) and the path to the rendered prompt file. Its job is to invoke the right agent with the right flags.

Switchboard calls agent.sh as:

```
agent.sh <agent-name> <prompt-file>
```

The script runs with:
- `cwd` set to the workspace directory (or project root if no workspace)
- The task environment variables, `SWITCHBOARD_PROJECT_ROOT`, `SWITCHBOARD_DISPATCH_ID`, and `SWITCHBOARD_WATCHER` are set
- `stdout` and `stderr` are written to the step's log file (see **Logging**)

A zero exit code means success. Non-zero means failure.

### Default agent script

Switchboard ships a built-in default `agent.sh`, inlined in the TypeScript source. It handles the known agents:

```bash
#!/bin/bash
set -euo pipefail

AGENT="$1"
PROMPT_FILE="$2"

case "$AGENT" in
  opencode)
    opencode -p "$(cat "$PROMPT_FILE")"
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
```

The `*` fallback means `--agent=./agents/my-agent` works automatically -- Switchboard invokes it with the prompt file path and lets the custom agent decide how to read it.

To override, create `.switchboard/commands/agent.sh`. This is useful when:
- A team uses an agent not covered by the default cases
- The agent needs specific flags, model overrides, or environment setup
- The team wants to wrap the agent with logging or metrics

### Default work prompt

Switchboard ships a built-in default `work.md`, inlined in the TypeScript source as a string literal. It provides a minimal prompt that passes the task to the agent:

```markdown
# {{task.identifier}}: {{task.title}}

{{task.description}}

Work on this task until it is complete.
```

This default runs when no `.switchboard/commands/work.md` exists in the project. It gives the agent the task title and description and asks it to complete the work. Most teams will override this with a project-specific prompt that includes repo conventions, testing instructions, or other guidance.

To override, create `.switchboard/commands/work.md`. Note that `work.sh` can also be used alongside or instead of `work.md` for shell-driven workflows.

### --agent flag

```
switchboard --watch=jira --agent=opencode
switchboard --watch=jira --agent=claude
switchboard --watch=jira --agent=./agents/my-agent
```

`--agent` is required. If omitted, Switchboard exits with an error. There is no default -- the agent ecosystem is moving fast and picking a winner now would age poorly.

The `--agent` value is passed as the first argument to `agent.sh`. Switchboard does not interpret it beyond that.

### Agent context across phases

Each `.md` step spawns a fresh agent process. There is no shared context between `init.md`, `work.md`, and `teardown.md`. If the init agent writes a plan to a file in the workspace, the work agent can read it -- but they do not share conversation history.

This is deliberate. Phases are independent units. The filesystem is the shared state.

## Logging

Switchboard is a TUI -- it has no scrollback buffer for raw subprocess output. All subprocess stdout and stderr are written to log files on disk.

### Dispatch ID

When the orchestrator accepts a task from the watcher, it assigns a **dispatch ID**: a random UUID, truncated to 8 characters. This ID uniquely identifies a single dispatch attempt. If the same task is retried later, it gets a new dispatch ID, so logs from different attempts never collide.

### Log path

Log files are written to:

```
.switchboard/logs/{watcher}/{task.identifier}/{dispatch-id}/{step}.log
```

The `{watcher}` segment is derived from the `--watch` value using these normalization rules:

| `--watch` value | `{watcher}` in log path | Rule |
|---|---|---|
| `jira` | `jira` | Built-in name used as-is |
| `./watchers/my-watcher.ts` | `my-watcher` | File path: basename without extension |
| `/abs/path/to/custom.sh` | `custom` | File path: basename without extension |
| (shell mode, no `--watch`) | `shell` | Literal `shell` |

This keeps log directories clean and predictable regardless of how the watcher was specified.

Each lifecycle step produces its own log file. A complete dispatch might produce:

```
.switchboard/logs/jira/PROJ-123/a1b2c3d4/init.sh.log
.switchboard/logs/jira/PROJ-123/a1b2c3d4/init.md.log
.switchboard/logs/jira/PROJ-123/a1b2c3d4/work.md.log
.switchboard/logs/jira/PROJ-123/a1b2c3d4/teardown.sh.log
```

Listing attempts for a task: `ls .switchboard/logs/jira/PROJ-123/`

### What gets logged

Each log file contains the interleaved stdout and stderr of that step's subprocess. `##switchboard:` directives are parsed by Switchboard **and** written to the log -- the log is a complete record of what the subprocess produced.

For agent steps (`.md` files), the log captures whatever `agent.sh` and the underlying agent write to stdout/stderr. This typically includes the agent's reasoning, tool calls, and output.

### Environment variable

All steps receive the dispatch ID so scripts can reference it (e.g., in commit messages or PR descriptions):

| Variable | Value |
|---|---|
| `SWITCHBOARD_DISPATCH_ID` | The 8-character dispatch ID for this attempt |

## Error Handling

### Init failure

If `init.sh` exits non-zero or `init.md`'s agent fails, the task is **not dispatched**. Work is skipped. **Teardown still runs** -- if init.sh partially created a workspace or branch, teardown must clean it up.

The task is marked as failed.

### Work failure

If `work.sh` exits non-zero or `work.md`'s agent fails, the task is marked as failed. **Teardown still runs.** The teardown phase may need to clean up partial work -- delete a branch, remove a workspace, post a failure comment.

### Teardown failure

If `teardown.md` or `teardown.sh` fails, the task is marked as **failed**. Silent failures in teardown cause resource leaks (orphaned worktrees, branches, workspace directories filling disk). Failing loudly ensures operators notice.

If work succeeded but teardown failed, the task is still marked failed. The work may have been fine, but the result was never delivered (branch not pushed, PR not opened, workspace not cleaned up). A task that cannot be delivered is not a successful task.

### Summary

| Phase | On failure | Teardown runs? | Task status |
|---|---|---|---|
| Init | Skip work | Yes | Failed |
| Work | Continue to teardown | Yes | Failed |
| Teardown | Log error | N/A | Failed |
| All succeed | -- | -- | Complete |

## Task Revisions (Re-dispatch)

A task may be dispatched more than once. A common flow:

1. Task arrives ("fix ABC"), Switchboard dispatches it.
2. The agent works, creates a PR, and the watcher marks the task as done.
3. A reviewer finds an issue and moves the task back to "To-do" with an updated description ("fix ABC, but don't change XYZ").
4. The watcher yields the task again on the next poll cycle. Same ID, same key, revised context.
5. Switchboard dispatches it again.

This works because:

- **Lock store has no memory of completed tasks.** When a dispatch finishes, the lock is released. There is no "completed" state. Re-pickup is controlled entirely by whether the watcher re-yields the task.
- **Init reuses the existing branch.** The default `init.sh` checks for an existing `switchboard/{identifier}` branch and creates a worktree from it rather than starting fresh. The agent picks up where the previous work left off.
- **Teardown handles existing PRs.** The default `teardown.md` instructs the agent to check for an existing PR on the branch before creating one. If a PR exists, the agent pushes new commits and updates the PR description. If not, it creates a new PR.
- **The watcher controls re-yield.** For Jira, the JQL query determines which tasks are candidates. If a reviewer moves a ticket back to "To-do", the JQL matches it again. For the file watcher, the task would need to be removed from the completed file or re-added to the source file.
- **Fresh task description.** The watcher fetches the task from the source on each poll, so the agent receives the updated description with reviewer feedback.

Each dispatch attempt gets its own dispatch ID and log directory, so logs from the original attempt and the revision never collide.

## DispatchHandle

The existing `DispatchHandle` interface remains unchanged:

```ts
interface DispatchHandle {
  pid: number
  done: Promise<void>
}
```

The `pid` is the PID of whichever subprocess is currently running (init script, agent, teardown script). Since the lifecycle is sequential, only one subprocess runs at a time per task. The `pid` updates as phases progress -- the orchestrator sees the PID of the latest subprocess.

The `done` promise resolves when the entire lifecycle completes (all phases succeed) or rejects if any phase fails. Rejection happens only after teardown has run.

## Example: Full Pipeline

A team using Jira and GitHub might set up:

```
.switchboard/
  commands/
    work.md
    teardown.sh
```

The default `init.sh` creates a git worktree automatically. The team only needs to define the work prompt and how to deliver results.

**work.md:**
```markdown
# {{task.identifier}}: {{task.title}}

## Description

{{task.description}}

## Instructions

You are working on a feature branch `switchboard/{{task.identifier}}` in a Node.js
project.

1. Read the task description above carefully.
2. Explore the relevant parts of the codebase.
3. Implement the requested changes.
4. Write or update tests for your changes.
5. Run `npm test` and fix any failures.
6. Commit your changes with a descriptive message referencing {{task.identifier}}.
```

**teardown.sh:**
```bash
#!/bin/bash
set -euo pipefail

# Push the branch
git push -u origin "switchboard/$TASK_IDENTIFIER"

# Open a PR if one doesn't already exist for this branch.
# If a PR exists (e.g., from a previous dispatch), the push above
# already updated it with the new commits.
if ! gh pr view "switchboard/$TASK_IDENTIFIER" --json url >/dev/null 2>&1; then
  gh pr create \
    --title "$TASK_IDENTIFIER: $TASK_TITLE" \
    --body "Automated PR for $TASK_URL" \
    --base main
fi

# Clean up the worktree
WORKSPACE="$SWITCHBOARD_PROJECT_ROOT/.switchboard/workspaces/$TASK_IDENTIFIER"
cd "$SWITCHBOARD_PROJECT_ROOT"
if [ -d "$WORKSPACE" ]; then
  git worktree remove "$WORKSPACE"
fi
```

## Example: Custom Agent Invocation

A team that needs specific agent flags can use `work.sh` alongside `work.md`, or instead of it:

```
.switchboard/
  commands/
    work.sh
```

**work.sh:**
```bash
#!/bin/bash
set -euo pipefail

opencode --prompt "Fix $TASK_IDENTIFIER: $TASK_TITLE" \
         --context "$TASK_DESCRIPTION" \
         --max-tokens 50000
```

The default init creates the worktree, `work.sh` invokes the agent with custom flags, and the default teardown cleans up the worktree.

## Example: No Workspace

A team that wants agents to work directly in the project root:

```
.switchboard/
  commands/
    init.sh
    work.md
```

**init.sh:**
```bash
#!/bin/bash
# Empty -- opt out of default worktree creation.
# No ##switchboard:cwd= directive means Switchboard stays in the project root.
```

**work.md:**
```markdown
# {{task.title}}

{{task.description}}

Make your changes directly in the project.
```

## Directory Layout

When Switchboard is running with the defaults, the project looks like:

```
myproject/
  .switchboard/
    commands/           # lifecycle files (user-created overrides)
      work.md
      teardown.sh
    logs/               # subprocess output (created by Switchboard)
      jira/
        PROJ-123/
          a1b2c3d4/     # first dispatch attempt
            init.sh.log
            work.md.log
            teardown.sh.log
          f9e8d7c6/     # second attempt (retry)
            init.sh.log
            work.md.log
            teardown.sh.log
        PROJ-456/
          b2c3d4e5/
            init.sh.log
            work.md.log
            teardown.sh.log
    workspaces/         # task workspaces (created by default init.sh)
      PROJ-123/         # git worktree for task PROJ-123
      PROJ-456/         # git worktree for task PROJ-456
  src/
  package.json
  ...
```

The `.switchboard/workspaces/` and `.switchboard/logs/` directories should be added to `.gitignore`.

## CLI Summary

New flags introduced by this spec:

| Flag | Default | Required | Description |
|---|---|---|---|
| `--agent=<cmd>` | none | **yes** | Agent name or path, passed to `agent.sh` |
| `--dispatch=<dir>` | `.switchboard/commands/` | no | Path to the commands directory |

## Next Steps

1. Implement `createDispatcher(config)` factory that reads the commands directory, merges defaults for any missing files, and returns a `Dispatcher` function.
2. Wire the dispatcher into the orchestrator, replacing the stub.
3. Implement Mustache template rendering for `.md` files.
4. Implement `##switchboard:` stdout directive parsing, starting with `cwd`.
5. Implement the `agent.sh` invocation layer for `.md` steps.
6. Inline the default `init.sh`, `teardown.sh`, `agent.sh`, and `work.md` scripts as string constants.
7. Add `--agent` and `--dispatch` to `parseArgs`.
8. Implement dispatch ID generation and log file routing.
9. Assign dispatch ID in the orchestrator when a task is accepted from the watcher.
