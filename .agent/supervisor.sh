#!/usr/bin/env bash
# ── Agent pipeline supervisor ──
# Keeps the multi-agent watcher alive: restarts it if the process dies.
# Designed to run inside tmux:   ./.agent/supervisor.sh
#
#   tmux new -s agent
#   cd ~/Projects/qc-gas && ./.agent/supervisor.sh
#   # Ctrl-b d 脱离；tmux attach -t agent 回来
set -u
cd "$(dirname "$0")/.." || exit 1

export MAX_REVIEW_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
# Inject the Mapbox token for Agent C's functional tests when .env exists
if [ -f .env ]; then export TEST_ENV_FILE="$PWD/.env"; fi

LOG=.agent/watch.log
echo "[supervisor $(date '+%F %T')] starting — MAX_REVIEW_ROUNDS=$MAX_REVIEW_ROUNDS TEST_ENV_FILE=${TEST_ENV_FILE:-<unset>}" | tee -a "$LOG"

while true; do
  npm run agent:watch 2>&1 | tee -a "$LOG"
  code=${PIPESTATUS[0]}
  echo "[supervisor $(date '+%F %T')] pipeline exited (code=$code); restarting in 10s" | tee -a "$LOG"
  sleep 10
done
