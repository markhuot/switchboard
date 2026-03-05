#!/bin/bash
set -euo pipefail

AGENT="${1:-opencode}"
TASKS_FILE="tasks.ndjson"

WATCHER_FILE="$TASKS_FILE" \
  bun ../src/index.tsx \
  --watch=file \
  --agent="$AGENT" \
  --concurrency=1
