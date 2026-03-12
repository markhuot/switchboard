import type { SwitchboardConfig, Watcher } from "../types"

export function help(): string {
  return `Watcher: github

GitHub Issues watcher (not yet implemented).

Planned environment variables:
  GITHUB_TOKEN              GitHub access token
  GITHUB_REPOSITORY         Repository in owner/name format
  GITHUB_QUERY              Issue filter query`
}

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  return {
    async *fetch() {
      // TODO: Implement GitHub Issues API integration
      // Watcher handles its own auth via environment variables (e.g., GITHUB_TOKEN)
    },
  }
}
