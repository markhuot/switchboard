import { resolve } from "path"
import type { SwitchboardConfig, Watcher } from "./types"

const builtins: Record<string, string> = {
  linear: "linear",
  github: "github",
  jira: "jira",
  shell: "shell",
  file: "file",
}

/**
 * Resolve a --watch flag value into a Watcher instance.
 *
 * Mode resolution:
 * 1. Starts with "$ " -> shell mode (command executed via bash)
 * 2. Contains "/" or starts with "." -> module mode (TypeScript file)
 * 3. Otherwise -> built-in watcher by name
 */
export async function resolveWatcher(
  config: SwitchboardConfig
): Promise<Watcher> {
  const flag = config.watch

  // Shell mode
  if (flag.startsWith("$ ")) {
    const mod = await import(`${import.meta.dir}/watchers/shell.ts`)
    return mod.default(config)
  }

  // Module mode
  if (flag.includes("/") || flag.startsWith(".")) {
    const mod = await import(resolve(flag))
    return mod.default(config)
  }

  // Built-in mode
  const builtinName = builtins[flag]
  if (!builtinName) {
    console.error(`Unknown built-in watcher: "${flag}"`)
    console.error(`Available: ${Object.keys(builtins).join(", ")}`)
    process.exit(1)
  }

  const mod = await import(`${import.meta.dir}/watchers/${builtinName}.ts`)
  return mod.default(config)
}
