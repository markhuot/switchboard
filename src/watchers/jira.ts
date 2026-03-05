import { readFileSync } from "fs"
import { join } from "path"
import type { SwitchboardConfig, Task, PutContext, Watcher } from "../types"

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
  try {
    const res = await fetch(
      `${baseUrl}/rest/api/2/issue/${issueId}/transitions`,
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      }
    )

    if (!res.ok) {
      console.warn(
        `Failed to fetch transitions for ${issueId}: ${res.status} ${res.statusText}`
      )
      return
    }

    const data: { transitions: { id: string; name: string }[] } =
      await res.json()

    const match = data.transitions.find(
      (t) => t.name.toLowerCase() === transitionName.toLowerCase()
    )

    if (!match) {
      console.warn(
        `Transition "${transitionName}" not found for issue ${issueId}. ` +
          `Available: ${data.transitions.map((t) => t.name).join(", ")}`
      )
      return
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
      console.warn(
        `Failed to transition ${issueId} to "${transitionName}": ${postRes.status} ${postRes.statusText}`
      )
    }
  } catch (err) {
    console.warn(`Error transitioning issue ${issueId}:`, err)
  }
}

export async function addComment(
  baseUrl: string,
  headers: Record<string, string>,
  issueId: string,
  body: string
): Promise<void> {
  try {
    const res = await fetch(
      `${baseUrl}/rest/api/2/issue/${issueId}/comment`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(15_000),
      }
    )

    if (!res.ok) {
      console.warn(
        `Failed to add comment to ${issueId}: ${res.status} ${res.statusText}`
      )
    }
  } catch (err) {
    console.warn(`Error adding comment to issue ${issueId}:`, err)
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
  context: PutContext
): Promise<void> {
  const workLogPath = join(task.results!.logDir, "work.md.log")
  let summary: string

  try {
    const workLog = readFileSync(workLogPath, "utf-8")
    summary = await context.summarize(workLog)
  } catch {
    summary = "(no work log available)"
  }

  // Append PR link if the teardown agent created one
  const prUrl = context.output.pr_url
  if (prUrl) {
    summary += `\n\nPull request: ${prUrl}`
  }

  if (task.results?.status === "complete") {
    await transitionIssue(
      baseUrl,
      headers,
      task.id,
      process.env.JIRA_DONE_TRANSITION ?? "Done"
    )
    await addComment(baseUrl, headers, task.id, summary)
  } else {
    await addComment(baseUrl, headers, task.id, `Dispatch failed:\n\n${summary}`)
  }
}

export function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}

// --- Watcher factory ---

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  const baseUrl = requireEnv("JIRA_BASE_URL")
  const token = requireEnv("JIRA_TOKEN")
  const jql = requireEnv("JIRA_JQL")
  const headers = buildHeaders(token)

  return {
    fetch: () => fetchIssues(baseUrl, headers, jql),

    put: (task: Task, context: PutContext) =>
      putResults(baseUrl, headers, task, context),
  }
}
