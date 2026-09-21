#!/usr/bin/env bash
# ── PM agent supervisor ──
# Wakes every 30 min; run.mjs decides whether this week's run is due.
# Cheap when idle (local date math only, no network unless due).
#
#   tmux new -s pm
#   cd ~/Projects/qc-gas && ./.agent/pm/supervisor.sh
set -u
cd "$(dirname "$0")/../.." || exit 1

LOG=.agent/pm/supervisor.log
echo "[pm-supervisor $(date '+%F %T')] up — daily ${PM_HOUR_UTC:-17}:00 UTC (off-peak window ${PM_WINDOW_START_UTC:-16.5}–${PM_WINDOW_END_UTC:-24.5}), cap=${PM_DAILY_CAP:-1}/day, ${PM_WEEKLY_CAP:-5}/week" | tee -a "$LOG"

while true; do
  node .agent/pm/run.mjs 2>&1 | tee -a "$LOG"
  sleep 900   # 15 min — cheap when idle (local date math, no network until due)
done
