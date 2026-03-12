import type { SwitchboardConfig, Watcher } from "../types"

export function help(): string {
  return `Watcher: linear

Linear watcher (not yet implemented).

Planned environment variables:
  LINEAR_API_KEY            Linear API key
  LINEAR_TEAM_ID            Team identifier
  LINEAR_QUERY              Issue filter query`
}

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  return {
    async *fetch() {
      // TODO: Implement Linear API integration
      // Watcher handles its own auth via environment variables (e.g., LINEAR_API_KEY)
    },
  }
}
