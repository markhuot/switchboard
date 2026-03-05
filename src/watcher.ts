import { homedir } from "os"
import { resolve } from "path"
import type { SwitchboardConfig, Watcher, WatcherFactoryContext } from "./types"

function expandTilde(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}

const builtins: Record<string, string> = {
  linear: "linear",
  github: "github",
  jira: "jira",
  shell: "shell",
  file: "file",
}

async function loadBuiltin(
  name: string,
  config: SwitchboardConfig,
  env?: Record<string, string>
): Promise<Watcher> {
  const builtinName = builtins[name]
  if (!builtinName) {
    throw new Error(
      `Unknown built-in watcher: "${name}". ` +
        `Available: ${Object.keys(builtins).join(", ")}`
    )
  }

  const saved: Record<string, string | undefined> = {}
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
  }

  try {
    const mod = await import(`${import.meta.dir}/watchers/${builtinName}.ts`)
    return mod.default(config)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function buildContext(config: SwitchboardConfig): WatcherFactoryContext {
  return {
    createWatcher: (name: string, env?: Record<string, string>) =>
      loadBuiltin(name, config, env),
  }
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
  const context = buildContext(config)

  // Shell mode
  if (flag.startsWith("$ ")) {
    const mod = await import(`${import.meta.dir}/watchers/shell.ts`)
    return mod.default(config, context)
  }

  // Module mode
  if (flag.includes("/") || flag.startsWith(".")) {
    const mod = await import(resolve(expandTilde(flag)))
    return await mod.default(config, context)
  }

  // Built-in mode
  const builtinName = builtins[flag]
  if (!builtinName) {
    console.error(`Unknown built-in watcher: "${flag}"`)
    console.error(`Available: ${Object.keys(builtins).join(", ")}`)
    process.exit(1)
  }

  const mod = await import(`${import.meta.dir}/watchers/${builtinName}.ts`)
  return mod.default(config, context)
}
