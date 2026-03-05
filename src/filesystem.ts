import { mkdirSync, existsSync, writeFileSync } from "fs"
import { join } from "path"

/**
 * Ensure the `.switchboard/` directory exists and contains a
 * `.gitignore` that ignores everything except the `commands/`
 * directory (user-land scripts that should be committed).
 *
 * Call this once at boot. The `.gitignore` is only written if it
 * does not already exist, so repeated calls are safe but unnecessary.
 */
export function ensureSwitchboardDir(projectRoot: string): void {
  const switchboardDir = join(projectRoot, ".switchboard")
  mkdirSync(switchboardDir, { recursive: true })
  const gitignorePath = join(switchboardDir, ".gitignore")
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      [
        "# Ignore everything except the commands directory",
        "*",
        "!.gitignore",
        "!commands/",
        "!commands/**",
        "",
      ].join("\n"),
    )
  }
}
