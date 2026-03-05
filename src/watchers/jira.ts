import type { SwitchboardConfig, Task, Watcher } from "../types"

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

// --- Watcher factory ---

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  const baseUrl = requireEnv("JIRA_BASE_URL")
  const token = requireEnv("JIRA_TOKEN")
  const jql = requireEnv("JIRA_JQL")

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }

  return {
    async *fetch() {
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
    },
  }
}
