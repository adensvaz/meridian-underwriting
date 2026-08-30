#!/usr/bin/env bash
# Ralph Wiggum loop — feed the same prompt to Claude until the backlog is clear.
#
#   ./ralph/loop.sh                    # run until done or MAX_ITERATIONS
#   MAX_ITERATIONS=5 ./ralph/loop.sh
#   DRY_RUN=1 ./ralph/loop.sh          # show what would happen, change nothing
#
# The idea is deliberately dumb: the same prompt, every iteration, against a
# backlog the model ticks off one item at a time. State lives in fix_plan.md and
# JOURNAL.md rather than in the conversation, so no iteration depends on
# remembering the last one — which is exactly why it survives a context reset,
# a crash, or a session limit.
#
# What this script adds over a bare `while true`:
#   * it will not start if the tree is already broken, so a red build cannot be
#     compounded by another change on top of it
#   * it verifies after every iteration and stops on a regression rather than
#     grinding through a further nineteen passes making things worse
#   * it detects a stalled loop — an iteration that ticks nothing and journals
#     nothing — and gives up after two in a row
#   * every iteration is committed, so a bad one is one `git revert` away

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

MAX_ITERATIONS="${MAX_ITERATIONS:-20}"
SENTINEL="MVP COMPLETE"
PROMPT_FILE="ralph/PROMPT.md"
JOURNAL="ralph/JOURNAL.md"
PLAN="ralph/fix_plan.md"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }

open_items() { grep -c '^\s*- \[ \]' "$PLAN" 2>/dev/null || echo 0; }
journal_lines() { wc -l < "$JOURNAL" 2>/dev/null | tr -d ' ' || echo 0; }

# The gate. Every one of these must pass before and after each iteration.
verify() {
  npm run arch   >/tmp/ralph-arch.log   2>&1 || { echo "arch gate failed"; tail -25 /tmp/ralph-arch.log; return 1; }
  npm run check  >/tmp/ralph-check.log  2>&1 || { echo "check failed";  tail -25 /tmp/ralph-check.log;  return 1; }
  npm run smoke  >/tmp/ralph-smoke.log  2>&1 || { echo "smoke failed";  tail -25 /tmp/ralph-smoke.log;  return 1; }
  # Discovered, not listed — a hand-maintained list silently stops covering
  # new tests the moment somebody forgets to add one.
  npm test >/tmp/ralph-test.log 2>&1 || { echo "tests failed"; tail -30 /tmp/ralph-test.log; return 1; }
  return 0
}

command -v claude >/dev/null 2>&1 || { echo "error: 'claude' CLI not on PATH"; exit 1; }
[ -f "$PROMPT_FILE" ] || { echo "error: $PROMPT_FILE missing"; exit 1; }
[ -f "$PLAN" ] || { echo "error: $PLAN missing"; exit 1; }
touch "$JOURNAL"

log "Ralph — verifying the tree is green before starting"
if ! verify; then
  echo "The build is already failing. Fix that first — the loop will not start on red."
  exit 1
fi
echo "green. $(open_items) open backlog item(s)."

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN — would run up to $MAX_ITERATIONS iteration(s) against:"
  grep -m 5 '^\s*- \[ \]' "$PLAN"
  exit 0
fi

stalled=0

for ((i = 1; i <= MAX_ITERATIONS; i++)); do
  if grep -qF "$SENTINEL" "$JOURNAL"; then
    log "Ralph: sentinel found — finished after $((i - 1)) iteration(s)"
    exit 0
  fi

  before_items=$(open_items)
  before_journal=$(journal_lines)

  if [ "$before_items" -eq 0 ]; then
    log "Ralph: no unchecked backlog items left"
    printf '\n%s\n' "$SENTINEL" >> "$JOURNAL"
    exit 0
  fi

  log "Iteration $i/$MAX_ITERATIONS — ${before_items} open — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  claude -p "$(cat "$PROMPT_FILE")" --permission-mode acceptEdits
  status=$?
  echo "--- iteration $i exited $status ---"

  if [ $status -ne 0 ]; then
    echo "warning: iteration $i failed; retrying once"
    claude -p "$(cat "$PROMPT_FILE")" --permission-mode acceptEdits || {
      echo "error: two consecutive failures — stopping"
      exit 1
    }
  fi

  log "Verifying iteration $i"
  if ! verify; then
    echo
    echo "Iteration $i left the build red. Stopping so it can be inspected."
    echo "Nothing was committed for this iteration; 'git status' shows the damage."
    exit 1
  fi
  echo "green."

  # Commit each good iteration so a later bad one is trivially revertable.
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git -c commit.gpgsign=false commit -q -m "ralph: iteration $i

$(grep '^\s*- \[x\]' "$PLAN" | tail -1 | sed 's/^\s*- \[x\] //' | cut -c1-72)" || true
    echo "committed."
  fi

  after_items=$(open_items)
  after_journal=$(journal_lines)

  if [ "$after_items" -eq "$before_items" ] && [ "$after_journal" -eq "$before_journal" ]; then
    stalled=$((stalled + 1))
    echo "note: iteration $i closed nothing and journalled nothing (stall $stalled/2)"
    if [ "$stalled" -ge 2 ]; then
      echo "error: two consecutive iterations made no progress — stopping"
      exit 1
    fi
  else
    stalled=0
  fi
done

log "Ralph: hit MAX_ITERATIONS=$MAX_ITERATIONS without the sentinel — $(open_items) item(s) still open"
exit 1
