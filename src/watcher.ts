import { homedir } from "os"
import { resolve } from "path"
import type { SwitchboardConfig, Watcher, WatcherFactoryContext } from "./types"
import createLinearWatcher, { help as linearHelp } from "./watchers/linear"
import createGithubWatcher, { help as githubHelp } from "./watchers/github"
import createJiraWatcher, { help as jiraHelp } from "./watchers/jira"
import createShellWatcher, { help as shellHelp } from "./watchers/shell"
import createFileWatcher, { help as fileHelp } from "./watchers/file"
import createTrackdownWatcher, { help as trackdownHelp } from "./watchers/trackdown"

type WatcherModule = {
  default: (
    config: SwitchboardConfig,
    context?: WatcherFactoryContext
  ) => Watcher | Promise<Watcher>
  help: () => string
}

type BuiltinWatcherModule = {
  create: (
    config: SwitchboardConfig,
    context?: WatcherFactoryContext
  ) => Watcher | Promise<Watcher>
  help: () => string
}

function expandTilde(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}

export const BUILTIN_WATCHERS = ["linear", "github", "jira", "shell", "file", "trackdown"] as const

const BUILTIN_WATCHER_MODULES: Record<string, BuiltinWatcherModule> = {
  linear: { create: createLinearWatcher, help: linearHelp },
  github: { create: createGithubWatcher, help: githubHelp },
  jira: { create: createJiraWatcher, help: jiraHelp },
  shell: { create: createShellWatcher, help: shellHelp },
  file: { create: createFileWatcher, help: fileHelp },
  trackdown: { create: createTrackdownWatcher, help: trackdownHelp },
}

function getBuiltinWatcherModule(name: string): BuiltinWatcherModule {
  const mod = BUILTIN_WATCHER_MODULES[name]
  if (!mod) {
    throw new Error(
      `Unknown built-in watcher: "${name}". ` +
        `Available: ${Object.keys(BUILTIN_WATCHER_MODULES).join(", ")}`
    )
  }
  return mod
}

async function loadBuiltin(
  name: string,
  config: SwitchboardConfig,
  env?: Record<string, string>
): Promise<Watcher> {
  const mod = getBuiltinWatcherModule(name)

  const saved: Record<string, string | undefined> = {}
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
  }

  try {
    return await mod.create(config)
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

async function importWatcherModule(modulePath: string): Promise<WatcherModule> {
  const mod = await import(modulePath)
  if (typeof mod.default !== "function") {
    throw new Error(`Watcher module is missing a default export: ${modulePath}`)
  }
  if (typeof mod.help !== "function") {
    throw new Error(`Watcher module is missing required help() export: ${modulePath}`)
  }
  return mod as WatcherModule
}

function resolveWatcherPath(watch: string): { kind: "builtin" | "module"; value: string } {
  if (watch.includes("/") || watch.startsWith(".")) {
    return { kind: "module", value: resolve(expandTilde(watch)) }
  }

  return { kind: "builtin", value: watch }
}

export async function getWatcherHelp(watch: string): Promise<string> {
  if (watch.startsWith("$ ")) {
    return getBuiltinWatcherModule("shell").help()
  }

  const resolved = resolveWatcherPath(watch)

  if (resolved.kind === "module") {
    const mod = await importWatcherModule(resolved.value)
    return mod.help()
  }

  return getBuiltinWatcherModule(resolved.value).help()
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
    return await getBuiltinWatcherModule("shell").create(config, context)
  }

  // Module mode
  if (flag.includes("/") || flag.startsWith(".")) {
    const mod = await importWatcherModule(resolve(expandTilde(flag)))
    return await mod.default(config, context)
  }

  // Built-in mode
  const builtin = BUILTIN_WATCHER_MODULES[flag]
  if (!builtin) {
    console.error(`Unknown built-in watcher: "${flag}"`)
    console.error(`Available: ${Object.keys(BUILTIN_WATCHER_MODULES).join(", ")}`)
    process.exit(1)
  }

  return await builtin.create(config, context)
}
