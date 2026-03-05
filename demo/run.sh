#!/bin/bash
set -euo pipefail

TASKS_FILE="tasks.ndjson"

rm -rf .switchboard/logs/

WATCHER_FILE="$TASKS_FILE" \
  bun ../src/index.tsx \
  --watch=file \
  --agent=opencode \
  --concurrency=3 \
  "$@"
