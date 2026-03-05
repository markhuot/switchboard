import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { renderAsciiText } from "./config"
import {
  DEFAULT_INIT_SH,
  DEFAULT_TEARDOWN_SH,
  DEFAULT_TEARDOWN_MD,
  DEFAULT_AGENT_SH,
  DEFAULT_WORK_MD,
} from "./dispatcher"

// ---------------------------------------------------------------------------
// Default command files available for export
// ---------------------------------------------------------------------------

export const COMMAND_FILES: Record<string, string> = {
  "init.sh": DEFAULT_INIT_SH,
  "work.md": DEFAULT_WORK_MD,
  "teardown.md": DEFAULT_TEARDOWN_MD,
  "teardown.sh": DEFAULT_TEARDOWN_SH,
  "agent.sh": DEFAULT_AGENT_SH,
}

// ---------------------------------------------------------------------------
// Export result type
// ---------------------------------------------------------------------------

export interface ExportFileResult {
  filename: string
  action: "write" | "skip"
}

export interface ExportResult {
  files: ExportFileResult[]
}

// ---------------------------------------------------------------------------
// Export categories (keyed by name)
// ---------------------------------------------------------------------------

const CATEGORIES = ["commands"] as const
export type ExportCategory = (typeof CATEGORIES)[number]

// ---------------------------------------------------------------------------
// Public entry point (CLI)
// ---------------------------------------------------------------------------

/**
 * Handle `switchboard export [category]`.
 * Exits the process when done.
 */
export function runExport(argv: string[]): void {
  // argv: [bun, script, "export", ...rest]
  const args = argv.slice(3)

  if (args.includes("--help") || args.includes("-h")) {
    printExportHelp()
    process.exit(0)
  }

  const category = args[0]

  if (!category) {
    // `switchboard export` — export everything
    const result = exportCommands(process.cwd())
    printExportResult(result)
    process.exit(0)
  }

  if (!CATEGORIES.includes(category as ExportCategory)) {
    console.error(`Error: unknown export category "${category}".`)
    console.error(`Available categories: ${CATEGORIES.join(", ")}`)
    process.exit(1)
  }

  if (category === "commands") {
    const result = exportCommands(process.cwd())
    printExportResult(result)
  }

  process.exit(0)
}

// ---------------------------------------------------------------------------
// Export: commands (testable — no process.exit, no console.log)
// ---------------------------------------------------------------------------

/**
 * Export default command files to `.switchboard/commands/` under the
 * given project root. Returns a result describing what was written
 * and what was skipped.
 */
export function exportCommands(projectRoot: string): ExportResult {
  const commandsDir = join(projectRoot, ".switchboard", "commands")
  mkdirSync(commandsDir, { recursive: true })

  const files: ExportFileResult[] = []

  for (const [filename, content] of Object.entries(COMMAND_FILES)) {
    const filepath = join(commandsDir, filename)
    if (existsSync(filepath)) {
      files.push({ filename, action: "skip" })
    } else {
      writeFileSync(filepath, content)
      files.push({ filename, action: "write" })
    }
  }

  return { files }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printExportResult(result: ExportResult): void {
  for (const f of result.files) {
    if (f.action === "write") {
      console.log(`  write ${f.filename}`)
    } else {
      console.log(`  skip  ${f.filename} (already exists)`)
    }
  }

  const wrote = result.files.filter((f) => f.action === "write").length
  const skipped = result.files.filter((f) => f.action === "skip").length

  console.log()
  if (wrote > 0) {
    console.log(`Exported ${wrote} command file${wrote === 1 ? "" : "s"} to .switchboard/commands/`)
  }
  if (skipped > 0) {
    console.log(`Skipped ${skipped} file${skipped === 1 ? "" : "s"} that already exist${skipped === 1 ? "s" : ""}.`)
  }
  if (wrote === 0 && skipped > 0) {
    console.log("All command files already exist. Edit them directly to customize.")
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printExportHelp(): void {
  console.log(`${renderAsciiText("Switchboard")}

Export default configuration files for customization.

Usage:
  switchboard export              Export all default files
  switchboard export commands     Export default command files

Categories:
  commands    Lifecycle scripts and prompts used by the dispatcher.
              Files are written to .switchboard/commands/ and include:
                init.sh        Create a git worktree workspace
                work.md        Default agent work prompt
                teardown.md    Agent self-review and PR creation prompt
                teardown.sh    Worktree cleanup script
                agent.sh       Agent invocation adapter

              Existing files are never overwritten.`)
}
