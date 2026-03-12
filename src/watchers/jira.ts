import { readFileSync } from "fs"
import { join } from "path"
import type { CompleteContext, SwitchboardConfig, Task, Watcher } from "../types"

export function help(): string {
  return `Watcher: jira

Polls Jira issues using JQL.

Required environment variables:
  JIRA_BASE_URL             Jira base URL, e.g. https://acme.atlassian.net
  JIRA_TOKEN                Bearer token used for Jira API requests
  JIRA_WATCH_COLUMN         Jira status/column to poll from
  JIRA_DOING_COLUMN         Jira status/column to move to on dispatch start
  JIRA_DONE_COLUMN          Jira status/column to move to on successful completion

Optional environment variables:
  JIRA_JQL                  Override JQL query used to select tasks
  JIRA_COMMENT_VISIBILITY_ROLE
                             Jira role used for comment visibility (default: HC Internal)`
}

// --- Internal types ---

interface JiraSearchResponse {
  startAt: number
  maxResults: number
  total: number
  issues: JiraIssue[]
}

interface JiraIssue {
  id: string
  self: string
  key: string
  fields: {
    summary: string
    description: string | null
    priority: JiraPriority | null
    comment: JiraCommentWrapper
  }
}

interface JiraPriority {
  self: string
  id: string
  name: string
  iconUrl: string
}

interface JiraCommentWrapper {
  comments: JiraComment[]
  maxResults: number
  total: number
  startAt: number
}

interface JiraComment {
  author: {
    name: string
    displayName: string
  }
  body: string
  created: string
}

async function buildHttpErrorMessage(
  prefix: string,
  response: Response
): Promise<string> {
  let body = ""
  try {
    body = (await response.text()).trim()
  } catch {
    body = "(failed to read response body)"
  }

  if (!body) {
    body = "(empty response body)"
  }

  const maxBodyLength = 4_000
  if (body.length > maxBodyLength) {
    body = `${body.slice(0, maxBodyLength)}...`
  }

  return `${prefix}: ${response.status} ${response.statusText}; response body: ${body}`
}

// --- Helpers ---

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function buildDescription(
  description: string | null,
  comments: JiraComment[]
): string | null {
  const parts: string[] = []

  if (description) {
    parts.push(description)
  }

  if (comments.length > 0) {
    const formatted = comments.map((comment) => {
      const author = comment.author?.displayName ?? comment.author?.name ?? "Unknown"
      return `<comment author="${author}">\n${comment.body}\n</comment>`
    })
    parts.push(`<comments>\n${formatted.join("\n")}\n</comments>`)
  }

  return parts.length > 0 ? parts.join("\n\n") : null
}

export function normalize(issue: JiraIssue, baseUrl: string): Task {
  const description = buildDescription(
    issue.fields.description,
    issue.fields.comment?.comments ?? []
  )

  return {
    id: issue.id,
    identifier: issue.key,
    title: issue.fields.summary,
    description,
    url: `${baseUrl}/browse/${issue.key}`,
    priority: issue.fields.priority
      ? parseInt(issue.fields.priority.id, 10)
      : null,
  }
}

// --- API helpers ---

export async function transitionIssue(
  baseUrl: string,
  headers: Record<string, string>,
  issueId: string,
  transitionName: string
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/rest/api/2/issue/${issueId}/transitions`,
    {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    }
  )

  if (!res.ok) {
    throw new Error(await buildHttpErrorMessage(
      `Failed to fetch transitions for ${issueId}`,
      res
    ))
  }

  const data: { transitions: { id: string; name: string }[] } =
    await res.json()

  const match = data.transitions.find(
    (t) => t.name.toLowerCase() === transitionName.toLowerCase()
  )

  if (!match) {
    throw new Error(
      `Transition "${transitionName}" not found for issue ${issueId}. ` +
        `Available: ${data.transitions.map((t) => t.name).join(", ")}`
    )
  }

  const postRes = await fetch(
    `${baseUrl}/rest/api/2/issue/${issueId}/transitions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ transition: { id: match.id } }),
      signal: AbortSignal.timeout(15_000),
    }
  )

  if (!postRes.ok) {
    throw new Error(await buildHttpErrorMessage(
      `Failed to transition ${issueId} to "${transitionName}"`,
      postRes
    ))
  }
}

export async function addComment(
  baseUrl: string,
  headers: Record<string, string>,
  issueId: string,
  body: string
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/rest/api/2/issue/${issueId}/comment`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        body,
        visibility: {
          type: "role",
          value: process.env.JIRA_COMMENT_VISIBILITY_ROLE ?? "HC Internal",
        },
      }),
      signal: AbortSignal.timeout(15_000),
    }
  )

  if (!res.ok) {
    throw new Error(await buildHttpErrorMessage(
      `Failed to add comment to ${issueId}`,
      res
    ))
  }
}

export async function* fetchIssues(
  baseUrl: string,
  headers: Record<string, string>,
  jql: string
): AsyncGenerator<Task> {
  let startAt = 0

  while (true) {
    const response = await fetch(`${baseUrl}/rest/api/2/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: 10,
        fields: ["summary", "description", "priority", "comment"],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      throw new Error(
        `Jira search failed: ${response.status} ${response.statusText}`
      )
    }

    const data: JiraSearchResponse = await response.json()

    if (data.issues.length === 0) break

    for (const issue of data.issues) {
      yield normalize(issue, baseUrl)
    }

    startAt += data.issues.length
    if (startAt >= data.total) break
  }
}

export async function putResults(
  baseUrl: string,
  headers: Record<string, string>,
  task: Task,
  context: CompleteContext,
  doneColumn: string,
): Promise<void> {
  const workLogPath = join(task.results!.logDir, "work.md.log")
  let summary: string
  let skipComment = false

  try {
    const workLog = readFileSync(workLogPath, "utf-8")
    summary = (await context.summarize(workLog)).trim()
    if (!summary) {
      skipComment = true
      console.warn(
        `Summary for Jira issue ${task.id} was empty after summarization; skipping Jira comment writeback.`
      )
    }
  } catch {
    summary = "(no work log available)"
  }

  // Append PR link if the teardown agent created one
  const prUrl = context.output.pr_url
  if (prUrl && summary) {
    summary = `${summary}\n\nPull request: ${prUrl}`
  }

  if (task.results?.status === "complete") {
    await transitionIssue(
      baseUrl,
      headers,
      task.id,
      doneColumn,
    )
    if (!skipComment) {
      await addComment(baseUrl, headers, task.id, summary)
    }
  } else {
    if (!skipComment) {
      await addComment(baseUrl, headers, task.id, `Dispatch failed:\n\n${summary}`)
    }
  }
}

export function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

function quoteJqlValue(value: string): string {
  return `"${value.replaceAll(/(["\\])/g, "\\$1")}"`
}

export function buildWatchJql(watchColumn: string): string {
  return `status = ${quoteJqlValue(watchColumn)} ORDER BY priority ASC, created ASC`
}

// --- Watcher factory ---

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  const baseUrl = requireEnv("JIRA_BASE_URL")
  const token = requireEnv("JIRA_TOKEN")
  const watchColumn = requireEnv("JIRA_WATCH_COLUMN")
  const doingColumn = requireEnv("JIRA_DOING_COLUMN")
  const doneColumn = requireEnv("JIRA_DONE_COLUMN")
  const jql = process.env.JIRA_JQL ?? buildWatchJql(watchColumn)
  const headers = buildHeaders(token)

  return {
    fetch: () => fetchIssues(baseUrl, headers, jql),

    update: async (task: Task) => {
      await transitionIssue(baseUrl, headers, task.id, doingColumn)
    },

    complete: (task: Task, context: CompleteContext) =>
      putResults(baseUrl, headers, task, context, doneColumn),
  }
}
