#!/bin/bash
set -euo pipefail

TASKS_FILE="tasks-source.ndjson"

rm -rf "$TASKS_FILE"
rm -rf tasks-source-completed.ndjson

cp tasks.ndjson "$TASKS_FILE"
rm -rf .switchboard/logs/

WATCHER_FILE="$TASKS_FILE" \
  bun ../src/index.tsx \
  --watch=file \
  --agent=dummy \
  --concurrency=3 \
  "$@"
