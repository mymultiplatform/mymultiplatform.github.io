#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/des/mymultiplatform.github.io}"
APP_DIR="$REPO_DIR/pdf_server"
VENV_DIR="${VENV_DIR:-/home/des/mymserver-venv}"
ENV_FILE="${ENV_FILE:-/home/des/.config/mymserver.env}"
SERVICE_FILE="/etc/systemd/system/mymserver.service"
UPLOAD_DIR="${UPLOAD_DIR:-/home/des/Desktop/mymservertest}"

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
sudo systemctl daemon-reload
sudo systemctl enable --now mymserver

echo
echo "mymserver.service is active."
echo "Now add nginx route block from:"
echo "  $APP_DIR/deploy/nginx_server_location.conf"
echo "into your HTTPS server config for mymultiplatform.com, then run:"
echo "  sudo nginx -t && sudo systemctl reload nginx"
