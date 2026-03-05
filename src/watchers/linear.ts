import type { SwitchboardConfig, Watcher } from "../types"

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  return {
    async *fetch() {
      // TODO: Implement Linear API integration
      // Watcher handles its own auth via environment variables (e.g., LINEAR_API_KEY)
    },
  }
}
