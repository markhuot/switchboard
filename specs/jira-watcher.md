# Jira Watcher

Status: Draft

## Overview

The Jira watcher is a built-in watcher that fetches issues from a Jira Server (or Data Center) instance using the REST API v2. It targets **Jira 7.6.1** and uses only endpoints available in that version. The watcher conforms to the `Watcher` interface defined in the [initial watcher specification](./initial-watcher-approach.md).

The watcher's only job is fetching. It returns issues matching a JQL query as `Task` objects. Switchboard handles locking, dispatch, and everything else.

**API Reference:** [Jira Server REST API 7.6.1](https://docs.atlassian.com/software/jira/docs/api/REST/7.6.1/#api/2)

## Configuration

The Jira watcher handles its own configuration. Switchboard passes only the `SwitchboardConfig` object -- it does not pass API keys, project slugs, or JQL queries. The watcher reads everything it needs from environment variables.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JIRA_BASE_URL` | yes | Base URL of the Jira instance (e.g., `https://jira.example.com`). No trailing slash. |
| `JIRA_USERNAME` | yes | Username for HTTP Basic authentication. |
| `JIRA_PASSWORD` | yes | Password (or API token) for HTTP Basic authentication. |
| `JIRA_JQL` | yes | JQL query that defines which issues to fetch. This is the watcher's filter -- only issues matching this query are yielded as tasks. |

### Startup Validation

At construction time the watcher validates that all required environment variables are present. If any are missing it throws an error with a clear message listing the missing variables. This is a startup error -- Switchboard exits, per the error handling policy.

```ts
export default function createWatcher(config: SwitchboardConfig): Watcher {
  const baseUrl = requireEnv("JIRA_BASE_URL")
  const username = requireEnv("JIRA_USERNAME")
  const password = requireEnv("JIRA_PASSWORD")
  const jql = requireEnv("JIRA_JQL")

  // ...
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
```

## Authentication

The watcher uses **HTTP Basic authentication**. Each request includes an `Authorization` header with the Base64-encoded `username:password` pair.

```ts
const credentials = Buffer.from(`${username}:${password}`).toString("base64")
const headers = {
  Authorization: `Basic ${credentials}`,
  "Content-Type": "application/json",
}
```

This is the simplest auth mechanism supported by Jira Server 7.6.1. OAuth is also supported by Jira but adds significant complexity (token exchange, signing) that is not warranted for a server-side polling watcher. Users who need OAuth can write a custom watcher module.

## API Usage

### Search Endpoint

The watcher uses a single Jira REST API endpoint:

```
POST /rest/api/2/search
```

This endpoint accepts a JQL query in the request body and returns paginated results. Using POST avoids URL length limits and URL-encoding concerns for complex JQL queries. The watcher requests only the fields it needs to construct `Task` objects.

#### Request

```
POST {JIRA_BASE_URL}/rest/api/2/search
```

Request body:

```json
{
  "jql": "project = MYPROJ AND status != Done ORDER BY priority ASC",
  "startAt": 0,
  "maxResults": 10,
  "fields": ["summary", "description", "priority", "comment"]
}
```

| Field | Value |
|---|---|
| `jql` | Value of `JIRA_JQL`, passed as-is |
| `startAt` | Page offset, starting at `0` |
| `maxResults` | Hardcoded to `10`. Small pages keep memory low and align with the generator pattern -- Switchboard typically only needs a handful of tasks per tick. The watcher pages through as many times as needed to yield all matching issues. |
| `fields` | `["summary", "description", "priority", "comment"]` -- only the fields needed for `Task` mapping |

The `fields` parameter limits the response to just what we need. By default the search endpoint returns all navigable fields, which is wasteful. Requesting only `summary`, `description`, `priority`, and `comment` keeps payloads small.

#### Response Shape

```json
{
  "startAt": 0,
  "maxResults": 10,
  "total": 215,
  "issues": [
    {
      "id": "10001",
      "self": "https://jira.example.com/rest/api/2/issue/10001",
      "key": "PROJ-123",
      "fields": {
        "summary": "Fix login timeout on slow connections",
        "description": "When a user has a slow connection the login form times out...",
        "priority": {
          "self": "https://jira.example.com/rest/api/2/priority/3",
          "id": "3",
          "name": "Major",
          "iconUrl": "https://jira.example.com/images/icons/priorities/major.svg"
        },
        "comment": {
          "comments": [
            {
              "author": {
                "name": "jsmith",
                "displayName": "John Smith"
              },
              "body": "I can reproduce this on Chrome 63. Timeout happens after ~8 seconds.",
              "created": "2018-01-15T10:30:00.000+0000"
            },
            {
              "author": {
                "name": "mjones",
                "displayName": "Mary Jones"
              },
              "body": "This might be related to the keep-alive settings on the load balancer.",
              "created": "2018-01-16T14:22:00.000+0000"
            }
          ],
          "maxResults": 20,
          "total": 2,
          "startAt": 0
        }
      }
    }
  ]
}
```

Key response fields:

| Field | Type | Description |
|---|---|---|
| `startAt` | integer | Index of the first result returned |
| `maxResults` | integer | Maximum results per page |
| `total` | integer | Total matching issues (may change between pages) |
| `issues` | array | Array of issue objects |
| `issues[].id` | string | Internal Jira issue ID |
| `issues[].key` | string | Human-readable issue key (e.g., `PROJ-123`) |
| `issues[].self` | string (URI) | REST API URL for this issue |
| `issues[].fields.summary` | string | Issue title |
| `issues[].fields.description` | string or null | Issue body text |
| `issues[].fields.priority` | object or null | Priority object with `id` and `name` |
| `issues[].fields.comment` | object | Comment wrapper with `comments` array, `total`, and `maxResults` |
| `issues[].fields.comment.comments[]` | object | Individual comment with `author`, `body`, and `created` |

## Task Mapping

Each Jira issue maps to a `Task` object as follows:

| Task field | Source | Notes |
|---|---|---|
| `id` | `issue.id` | Jira's internal numeric ID as a string. Stable across key renames. |
| `identifier` | `issue.key` | Human-readable key like `PROJ-123`. |
| `title` | `issue.fields.summary` | Direct mapping. |
| `description` | `issue.fields.description` + `issue.fields.comment.comments` | Issue body text with comments appended. See **Comment Handling** below. Null only if the issue has no description and no comments. |
| `url` | Derived from `JIRA_BASE_URL` and `issue.key` | `{JIRA_BASE_URL}/browse/{issue.key}` |
| `priority` | `parseInt(issue.fields.priority.id, 10)` | Jira priority IDs are numeric strings. Parsed to integers. Lower IDs are higher priority in Jira's default scheme (1=Highest, 5=Lowest), which matches the `Task` convention. Null if priority is absent. |

```ts
function normalize(issue: JiraIssue, baseUrl: string): Task {
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
```

### Comment Handling

Jira comments often contain critical context -- reproduction steps, design decisions, scope clarifications -- that an agent needs to do useful work. The watcher appends all comments to the task description so the agent receives the full picture.

The `comment` field is included in the search request's `fields` array. Jira returns comments embedded in each issue's response, avoiding a separate API call per issue.

Comments are appended to the description in chronological order, wrapped in XML tags so an LLM can unambiguously identify where each comment starts and ends:

```ts
function buildDescription(
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
```

For an issue with a description and two comments, the resulting `Task.description` looks like:

```
When a user has a slow connection the login form times out...

<comments>
<comment author="John Smith">
I can reproduce this on Chrome 63. Timeout happens after ~8 seconds.
</comment>
<comment author="Mary Jones">
This might be related to the keep-alive settings on the load balancer.
</comment>
</comments>
```

The XML tags solve an ambiguity problem. With plain text separators like `Author:\nBody`, comment bodies that themselves contain names, colons, or blank lines become indistinguishable from comment boundaries. XML tags make the structure explicit at near-zero cost.

#### Comment Truncation

The Jira search endpoint returns a limited number of comments per issue (governed by the server's default page size, typically 20). For issues with many comments, the oldest comments may be omitted. This is an acceptable tradeoff:

- Most issues that are candidates for agent work are recently created or recently triaged and have few comments.
- The most recent comments tend to contain the most relevant context.
- Fetching complete comment histories would require a separate `GET /rest/api/2/issue/{key}/comment` call per issue, creating an N+1 problem that slows down the watcher and increases load on Jira.

### URL Construction

The `url` field is constructed as `{JIRA_BASE_URL}/browse/{issue.key}` rather than using the `self` field from the API response. The `self` field points to the REST API resource (`/rest/api/2/issue/10001`), not the human-browsable issue page. The `/browse/{key}` pattern is the standard Jira web UI URL and has been stable across all Jira versions.

### Priority Mapping

Jira's default priority scheme uses numeric IDs where lower numbers are higher priority:

| ID | Name |
|---|---|
| 1 | Highest |
| 2 | High |
| 3 | Medium |
| 4 | Low |
| 5 | Lowest |

This aligns with the `Task` interface convention where "lower is higher priority." Custom priority schemes may use different IDs, but the ordering convention (lower = more urgent) holds as long as the Jira admin configured priorities in descending order of urgency, which is the default.

If a Jira instance uses a non-standard priority scheme where IDs don't correspond to urgency order, the priority field will still be populated but may not sort correctly. This is an acceptable tradeoff -- the watcher does not attempt to normalize arbitrary priority schemes.

## Fetch Implementation

The `fetch()` method is an async generator that paginates through the Jira search results. It yields tasks one at a time, allowing Switchboard to stop pulling when concurrency slots are full -- at which point the watcher stops fetching subsequent pages.

```ts
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

      // Stop if we've fetched all results
      startAt += data.issues.length
      if (startAt >= data.total) break
    }
  },
}
```

### Pagination Behavior

The watcher paginates lazily using the async generator pattern:

1. Fetch page 1 (`startAt=0`, `maxResults=10`).
2. Yield each issue from the page as a `Task`.
3. If Switchboard breaks out of the `for await` loop (concurrency full), the generator is abandoned. Page 2 is never fetched.
4. If Switchboard consumes all issues from page 1, advance `startAt` and fetch page 2.
5. Continue until `issues` is empty or `startAt >= total`.

The `total` field in the Jira response may change between pages (per Jira's documentation). The watcher treats it as a hint -- the empty `issues` array is the authoritative signal that there are no more results.

### Request Timeout

Each HTTP request to Jira has a 15-second timeout via `AbortSignal.timeout(15_000)`. If Jira is slow or unresponsive the request aborts and the generator throws. Switchboard catches this in the poll loop and retries on the next tick.

## Error Handling

The watcher follows the error handling policy from the initial watcher specification:

| Failure | Behavior |
|---|---|
| Missing env vars at startup | Throws immediately. Switchboard exits. |
| HTTP 401 / 403 | Generator throws. Logged by Switchboard. Retry next tick. |
| HTTP 4xx / 5xx | Generator throws with status code and message. Retry next tick. |
| Network error / timeout | Generator throws. Retry next tick. |
| Malformed JSON response | Generator throws. Retry next tick. |
| Issue missing `id` or `summary` | Skipped by Switchboard's per-task validation. Other issues proceed. |

The watcher does not implement its own retry logic. It throws on any non-200 response and relies on Switchboard's poll loop to retry on the next tick. This keeps the watcher simple and avoids duplicate retry mechanisms.

### Transient vs Permanent Errors

The watcher does not distinguish between transient and permanent errors. A 401 (bad credentials) and a 503 (server overloaded) both result in the same behavior: throw, log, retry next tick. This is intentional:

- Credentials could be rotated mid-run, making a 401 transient.
- A Jira instance restart could cause brief 5xx errors that resolve on their own.
- The poll loop already provides natural retry cadence via `--poll-interval`.

If authentication is permanently broken the watcher will log an error on every tick. The operator sees repeated `401 Unauthorized` messages and fixes the credentials.

## Types

Internal types used by the watcher implementation. These are not part of the public Watcher interface.

```ts
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
```

## Full Implementation

The complete watcher module for reference:

```ts
// watchers/jira.ts
import type { Watcher, Task, SwitchboardConfig } from "switchboard"

export default function createWatcher(config: SwitchboardConfig): Watcher {
  const baseUrl = requireEnv("JIRA_BASE_URL")
  const username = requireEnv("JIRA_USERNAME")
  const password = requireEnv("JIRA_PASSWORD")
  const jql = requireEnv("JIRA_JQL")

  const credentials = Buffer.from(`${username}:${password}`).toString("base64")
  const headers = {
    Authorization: `Basic ${credentials}`,
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

function normalize(issue: JiraIssue, baseUrl: string): Task {
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

function buildDescription(
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

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
```

## Example Usage

### Basic: Fetch all open issues in a project

```bash
JIRA_BASE_URL=https://jira.example.com \
JIRA_USERNAME=bot-user \
JIRA_PASSWORD=secret \
JIRA_JQL="project = MYPROJ AND status != Done ORDER BY priority ASC" \
switchboard --watch=jira
```

### With custom poll interval and concurrency

```bash
JIRA_BASE_URL=https://jira.example.com \
JIRA_USERNAME=bot-user \
JIRA_PASSWORD=secret \
JIRA_JQL="project = MYPROJ AND status = 'To Do' ORDER BY priority ASC, created ASC" \
switchboard --watch=jira --poll-interval=1m --concurrency=5
```

### Scoped to a specific sprint

```bash
JIRA_JQL="project = MYPROJ AND sprint in openSprints() AND status = 'To Do' ORDER BY rank ASC"
```

### Scoped to a specific label

```bash
JIRA_JQL="project = MYPROJ AND labels = ai-ready AND status != Done ORDER BY priority ASC"
```

## JQL Guidance

The `JIRA_JQL` variable is the watcher's sole filtering mechanism. The watcher does not add any implicit filters -- it sends the JQL exactly as provided. This gives the operator full control.

Recommended patterns:

- **Always include a project filter** (`project = X`) to scope results.
- **Always exclude completed work** (`status != Done`) unless you want the watcher to re-yield finished tasks.
- **Order by priority** (`ORDER BY priority ASC`) so the highest-priority issues are yielded first. Since Switchboard may stop pulling after filling concurrency slots, ordering ensures the most important tasks are dispatched first.
- **Use `rank ASC`** if the board uses manual ranking, to respect the team's drag-and-drop ordering.

## Design Decisions

### Why `id` instead of `key` for Task.id?

Jira issue keys can change when an issue is moved between projects (e.g., `PROJ-123` becomes `OTHER-456`). The internal `id` is stable and never changes. Using `id` for the `Task.id` field prevents Switchboard from treating a moved issue as a new task.

The human-readable `key` is mapped to `Task.identifier` where it serves its purpose -- display and logging.

### Why POST instead of GET for the search endpoint?

Jira 7.6.1 supports both `GET /rest/api/2/search` and `POST /rest/api/2/search`. The watcher uses POST because:
1. JQL queries can be arbitrarily complex. GET encodes the query in the URL, which has length limits and requires URL-encoding. POST sends it in the request body, avoiding both problems.
2. The `fields` parameter is a JSON array in the POST body, which is cleaner than a comma-separated query string.
3. The tradeoff is that POST requests are slightly harder to reproduce in a browser, but for a server-side polling watcher this doesn't matter.

### Why Basic auth instead of OAuth?

Jira Server 7.6.1 supports both Basic auth and OAuth 1.0a. Basic auth is used because:
1. It requires only a username and password -- no token exchange, no signing, no consumer key registration.
2. For a server-side watcher that polls on a fixed interval, the simplicity tradeoff is worthwhile.
3. The connection should always be over HTTPS, which protects the credentials in transit.
4. Users who need OAuth can write a custom watcher module.

### Why no `/rest/api/2/serverInfo` health check?

An earlier draft considered calling `GET /rest/api/2/serverInfo` at startup to verify connectivity. This was dropped because:
1. The first `fetch()` call already validates connectivity. If Jira is unreachable, the search fails and Switchboard logs the error.
2. A successful `serverInfo` call doesn't guarantee the credentials or JQL are valid.
3. Adding a startup health check introduces a failure mode (Jira temporarily down at startup) that the poll loop already handles gracefully.
