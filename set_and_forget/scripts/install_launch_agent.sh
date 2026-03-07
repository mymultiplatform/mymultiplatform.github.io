#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER_REPO="${MYMSAF_RUNNER_REPO:-$HOME/.mymsaf/mymultiplatform.github.io}"
RUNTIME_DIR="$HOME/.mymsaf/runtime"
RUNNER="$RUNTIME_DIR/local_runner.sh"
LOG_DIR="$HOME/.mymsaf/logs"
LABEL="com.mymultiplatform.mymsaf.metrics"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$RUNTIME_DIR"

bash "$SOURCE_REPO_DIR/set_and_forget/scripts/bootstrap_runner_repo.sh"
cp "$SOURCE_REPO_DIR/set_and_forget/scripts/local_runner.sh" "$RUNNER"
chmod +x "$RUNNER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MYMSAF_REPO_DIR</key>
    <string>$RUNNER_REPO</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>7</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_VALUE" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
launchctl enable "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"

echo "Installed: $PLIST"
echo "Label: $LABEL"
echo "Logs: $LOG_DIR"
echo "Runner repo: $RUNNER_REPO"
