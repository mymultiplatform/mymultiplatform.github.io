#!/bin/bash
set -euo pipefail

LABEL="com.mymultiplatform.mymsaf.metrics"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE="$(id -u)"

launchctl bootout "gui/$UID_VALUE" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Removed: $PLIST"
echo "Runtime files kept in: $HOME/.mymsaf"
