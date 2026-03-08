#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/des/mymultiplatform.github.io}"
APP_DIR="$REPO_DIR/pdf_server"
VENV_DIR="${VENV_DIR:-/home/des/mymserver-venv}"
ENV_FILE="${ENV_FILE:-/home/des/.config/mymserver.env}"
SERVICE_FILE="/etc/systemd/system/mymserver.service"
TUNNEL_SERVICE_FILE="/etc/systemd/system/mymserver-tunnel.service"
SYNC_SERVICE_FILE="/etc/systemd/system/mymserver-redirect-sync.service"
SYNC_TIMER_FILE="/etc/systemd/system/mymserver-redirect-sync.timer"
SYNC_SCRIPT_TARGET="/usr/local/bin/mymserver-sync-redirect.sh"
UPLOAD_DIR="${UPLOAD_DIR:-/home/des/Desktop/mymservertest}"
SYNC_REPO_DIR="${SYNC_REPO_DIR:-/home/des/deploy/mymserver}"
CF_LOG_FILE="${CF_LOG_FILE:-/home/des/mymserver-cloudflared.log}"

if [[ ! -d "$APP_DIR" ]]; then
  echo "Missing app directory: $APP_DIR"
  exit 1
fi

sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip nginx

mkdir -p "$UPLOAD_DIR"
mkdir -p "$(dirname "$ENV_FILE")"

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<EOF_ENV
MMSERVER_USERNAME=DES333888
MMSERVER_PASSWORD=Sexo247420@
MMSERVER_UPLOAD_DIR=$UPLOAD_DIR
MMSERVER_MAX_UPLOAD_MB=40
MMSERVER_SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
MMSERVER_COOKIE_SECURE=true
EOF_ENV
  chmod 600 "$ENV_FILE"
fi

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$APP_DIR/requirements.txt"

sudo cp "$APP_DIR/deploy/mymserver.service" "$SERVICE_FILE"
sudo cp "$APP_DIR/deploy/mymserver-tunnel.service" "$TUNNEL_SERVICE_FILE"
sudo cp "$APP_DIR/deploy/sync_server_redirect.sh" "$SYNC_SCRIPT_TARGET"
sudo chmod 755 "$SYNC_SCRIPT_TARGET"

escaped_repo_dir="$(printf '%s\n' "$SYNC_REPO_DIR" | sed 's/[\\/&]/\\&/g')"
escaped_log_file="$(printf '%s\n' "$CF_LOG_FILE" | sed 's/[\\/&]/\\&/g')"
sed -e "s/__REPO_DIR__/$escaped_repo_dir/g" -e "s/__LOG_FILE__/$escaped_log_file/g" \
  "$APP_DIR/deploy/mymserver-redirect-sync.service" | sudo tee "$SYNC_SERVICE_FILE" >/dev/null
sudo cp "$APP_DIR/deploy/mymserver-redirect-sync.timer" "$SYNC_TIMER_FILE"

if ! command -v cloudflared >/dev/null 2>&1; then
  sudo apt-get install -y cloudflared || true
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Install it first, then rerun this script."
  exit 1
fi

sudo systemctl daemon-reload
sudo systemctl enable --now mymserver
sudo systemctl enable --now mymserver-tunnel
sudo systemctl enable --now mymserver-redirect-sync.timer
sudo systemctl start mymserver-redirect-sync.service || true

echo
echo "mymserver.service is active."
echo "mymserver-tunnel.service is active."
echo "mymserver-redirect-sync.timer is active."
echo "Public URL is managed automatically from Cloudflare tunnel logs."
echo "Now add nginx route block from:"
echo "  $APP_DIR/deploy/nginx_server_location.conf"
echo "into your HTTPS server config for mymultiplatform.com, then run:"
echo "  sudo nginx -t && sudo systemctl reload nginx"
