#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/des/mymultiplatform.github.io}"
APP_DIR="$REPO_DIR/pdf_server"
VENV_DIR="${VENV_DIR:-/home/des/mymserver-venv}"
ENV_FILE="${ENV_FILE:-/home/des/.config/mymserver.env}"
SERVICE_FILE="/etc/systemd/system/mymserver.service"
TUNNEL_SERVICE_FILE="/etc/systemd/system/mymserver-tunnel.service"
UPLOAD_DIR="${UPLOAD_DIR:-/home/des/Desktop/mymservertest}"
TUNNEL_SUBDOMAIN="${TUNNEL_SUBDOMAIN:-mymserverdes333888}"

if [[ ! -d "$APP_DIR" ]]; then
  echo "Missing app directory: $APP_DIR"
  exit 1
fi

sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip nginx nodejs npm

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
sed "s/__SUBDOMAIN__/$TUNNEL_SUBDOMAIN/g" \
  "$APP_DIR/deploy/mymserver-tunnel.service" | sudo tee "$TUNNEL_SERVICE_FILE" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now mymserver
sudo systemctl enable --now mymserver-tunnel

echo
echo "mymserver.service is active."
echo "mymserver-tunnel.service is active."
echo "Public URL:"
echo "  https://$TUNNEL_SUBDOMAIN.loca.lt/server"
echo "Now add nginx route block from:"
echo "  $APP_DIR/deploy/nginx_server_location.conf"
echo "into your HTTPS server config for mymultiplatform.com, then run:"
echo "  sudo nginx -t && sudo systemctl reload nginx"
