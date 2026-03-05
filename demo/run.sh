#!/bin/bash
set -euo pipefail

TASKS_FILE="tasks-source.ndjson"

if [[ "${1:-}" == "--cleanup" ]]; then
  rm -rf "$TASKS_FILE"
  rm -rf tasks-source-completed.ndjson
  rm -rf .switchboard/logs/
  shift
fi

cp tasks.ndjson "$TASKS_FILE"

WATCHER_FILE="$TASKS_FILE" \
  bun ../src/index.tsx \
  --watch=file \
  --agent=dummy \
  --concurrency=3 \
  "$@"
