#!/bin/bash
# Dagelijkse automatische back-up van app.cirqo.nl naar GitHub (bar/main).
# Gepland via launchd: ~/Library/LaunchAgents/nl.cirqo.git-backup.plist
cd /Users/joranstraatman/cirqo/app.cirqo.nl || exit 1
LOG=/Users/joranstraatman/cirqo/app.cirqo.nl/.backup.log
{
  echo "── $(date '+%Y-%m-%d %H:%M') ──"
  git add -A
  git restore --staged .DS_Store 2>/dev/null
  if git diff --cached --quiet; then
    echo "geen wijzigingen — niets te back-uppen"
  else
    git commit -m "Automatische dagelijkse back-up $(date '+%Y-%m-%d')"
    git push bar main && echo "gepusht naar GitHub ✓" || echo "PUSH MISLUKT — check ssh/netwerk"
  fi
} >> "$LOG" 2>&1
# logbestand begrensd houden
tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
