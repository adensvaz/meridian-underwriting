#!/usr/bin/env bash
# Ralph Wiggum loop — feed the same prompt to Claude until the MVP is done.
#
#   ./ralph/loop.sh                  # run up to MAX_ITERATIONS
#   MAX_ITERATIONS=5 ./ralph/loop.sh
#
# The idea is deliberately dumb: the same prompt, every time, against a backlog
# the model ticks off one item per pass. State lives in fix_plan.md and
# JOURNAL.md rather than in the conversation, so no iteration depends on
# remembering the last one. Stops when JOURNAL.md ends with the sentinel.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

MAX_ITERATIONS="${MAX_ITERATIONS:-20}"
SENTINEL="MVP COMPLETE"
PROMPT_FILE="ralph/PROMPT.md"
JOURNAL="ralph/JOURNAL.md"
PLAN="ralph/fix_plan.md"

command -v claude >/dev/null 2>&1 || { echo "error: 'claude' CLI not on PATH"; exit 1; }
[ -f "$PROMPT_FILE" ] || { echo "error: $PROMPT_FILE missing"; exit 1; }
[ -f "$PLAN" ] || { echo "error: $PLAN missing"; exit 1; }
touch "$JOURNAL"

for ((i = 1; i <= MAX_ITERATIONS; i++)); do
  if grep -qF "$SENTINEL" "$JOURNAL"; then
    echo "=== Ralph: sentinel found, MVP complete after $((i - 1)) iteration(s) ==="
    exit 0
  fi

  remaining=$(grep -c '^\s*- \[ \]' "$PLAN" 2>/dev/null || echo 0)
  echo "=== Ralph iteration $i/$MAX_ITERATIONS — ${remaining} open item(s) — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

  claude -p "$(cat "$PROMPT_FILE")" --permission-mode acceptEdits
  status=$?
  echo "--- iteration $i exited with status $status ---"

  # A hard failure twice in a row is a stuck loop, not a flake.
  if [ $status -ne 0 ]; then
    echo "warning: iteration $i failed; retrying once before giving up"
    claude -p "$(cat "$PROMPT_FILE")" --permission-mode acceptEdits || {
      echo "error: two consecutive failures — stopping"
      exit 1
    }
  fi

  # A pass that ticks nothing and journals nothing is spinning. Surface it
  # rather than burning the remaining iterations silently.
  now=$(grep -c '^\s*- \[ \]' "$PLAN" 2>/dev/null || echo 0)
  if [ "$now" -eq "$remaining" ]; then
    echo "note: iteration $i closed no backlog items"
  fi
done

echo "=== Ralph: hit MAX_ITERATIONS=$MAX_ITERATIONS without the sentinel ==="
exit 1
