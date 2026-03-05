import type { SwitchboardConfig, Watcher } from "../types"

export default function createWatcher(_config: SwitchboardConfig): Watcher {
  return {
    async *fetch() {
      // TODO: Implement GitHub Issues API integration
      // Watcher handles its own auth via environment variables (e.g., GITHUB_TOKEN)
    },
  }
}
