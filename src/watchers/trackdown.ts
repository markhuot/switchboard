import { existsSync, mkdirSync, renameSync } from "fs"
import { basename, extname, join, resolve } from "path"
import type { CompleteContext, SwitchboardConfig, Task, UpdateContext, Watcher } from "../types"

export function help(): string {
  return `Watcher: trackdown

Reads markdown cards from a Trackdown watch column and moves completed cards.

Required environment variables:
  TRACKDOWN_ROOT            Path to board root directory
  TRACKDOWN_WATCH_COLUMN    Relative path to the watch column directory
  TRACKDOWN_DONE_COLUMN     Relative path to the done column directory

Optional environment variables:
  TRACKDOWN_ACTIVE_COLUMN   Relative path to move cards when work starts`
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function listMarkdownFiles(columnPath: string): string[] {
  return Array.from(new Bun.Glob("*.md").scanSync({ cwd: columnPath }))
    .map((name) => join(columnPath, name))
    .sort((a, b) => a.localeCompare(b))
}

function normalizeTask(filePath: string): Task {
  const title = basename(filePath, extname(filePath))

  return {
    id: title,
    identifier: title,
    title,
    description: null,
    url: null,
    priority: null,
  }
}

async function safeReadMarkdown(filePath: string): Promise<string | null> {
  try {
    return await Bun.file(filePath).text()
  } catch {
    return null
  }
}

function cardFileName(task: Task): string {
  return `${task.id}.md`
}

function setLogsFrontmatter(markdown: string, logDir: string): string {
  const normalizedLogPattern = `${logDir.replaceAll("\\", "/").replace(/\/$/, "")}/*.log`
  const logsLine = `logs: ${JSON.stringify(normalizedLogPattern)}`
  const frontmatterStart = "---\n"

  if (markdown.startsWith(frontmatterStart)) {
    const closingMatch = /\n---\s*(\n|$)/.exec(markdown.slice(frontmatterStart.length))
    if (!closingMatch) {
      return `${frontmatterStart}${logsLine}\n---\n${markdown}`
    }

    const relativeClosingIndex = markdown
      .slice(frontmatterStart.length)
      .indexOf(closingMatch[0])
    const closingIndex = frontmatterStart.length + relativeClosingIndex
    const frontmatterBody = markdown.slice(frontmatterStart.length, closingIndex)
    const rest = markdown.slice(closingIndex)

    if (/^logs\s*:/m.test(frontmatterBody)) {
      const updatedBody = frontmatterBody.replace(/^logs\s*:.*$/m, logsLine)
      return `${frontmatterStart}${updatedBody}${rest}`
    }

    const suffix = frontmatterBody.endsWith("\n") || frontmatterBody.length === 0 ? "" : "\n"
    return `${frontmatterStart}${frontmatterBody}${suffix}${logsLine}${rest}`
  }

  return `${frontmatterStart}${logsLine}\n---\n${markdown}`
}

function resolveCurrentCardPath(
  task: Task,
  watchColumnPath: string,
  activeColumnPath: string | null,
): string | null {
  const fileName = cardFileName(task)
  const candidates = [
    activeColumnPath ? join(activeColumnPath, fileName) : null,
    join(watchColumnPath, fileName),
  ]

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  const boardRoot = resolve(requireEnv("TRACKDOWN_ROOT"))
  const watchColumn = requireEnv("TRACKDOWN_WATCH_COLUMN")
  const doneColumn = requireEnv("TRACKDOWN_DONE_COLUMN")
  const activeColumn = process.env.TRACKDOWN_ACTIVE_COLUMN

  const watchColumnPath = resolve(boardRoot, watchColumn)
  const doneColumnPath = resolve(boardRoot, doneColumn)
  const activeColumnPath = activeColumn
    ? resolve(boardRoot, activeColumn)
    : null

  if (!existsSync(watchColumnPath)) {
    throw new Error(`Watch column path does not exist: ${watchColumnPath}`)
  }

  return {
    async *fetch(): AsyncGenerator<Task> {
      const filePaths = listMarkdownFiles(watchColumnPath)

      for (const filePath of filePaths) {
        const description = await safeReadMarkdown(filePath)
        if (description === null) continue

        const task = normalizeTask(filePath)
        task.description = description
        yield task
      }
    },

    async update(task: Task, context: UpdateContext): Promise<void> {
      const sourcePath = resolveCurrentCardPath(task, watchColumnPath, activeColumnPath)
      if (!sourcePath) {
        return
      }

      const markdown = await safeReadMarkdown(sourcePath)
      if (markdown !== null) {
        await Bun.write(sourcePath, setLogsFrontmatter(markdown, context.logDir))
      }

      if (!activeColumnPath) {
        return
      }

      const targetPath = join(activeColumnPath, cardFileName(task))

      if (sourcePath === targetPath) {
        return
      }

      mkdirSync(activeColumnPath, { recursive: true })

      if (existsSync(targetPath)) {
        throw new Error(`Target card already exists: ${targetPath}`)
      }

      renameSync(sourcePath, targetPath)
    },

    async complete(task: Task, _context: CompleteContext): Promise<void> {
      if (task.results?.status !== "complete") {
        return
      }

      const sourcePath = resolveCurrentCardPath(task, watchColumnPath, activeColumnPath)
      if (!sourcePath) {
        return
      }

      const targetPath = join(doneColumnPath, cardFileName(task))

      mkdirSync(doneColumnPath, { recursive: true })

      if (existsSync(targetPath)) {
        throw new Error(`Target card already exists: ${targetPath}`)
      }

      renameSync(sourcePath, targetPath)
    },
  }
}
