#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running direct deployment installer (Cloudflare tunnel disabled)."
exec "$SCRIPT_DIR/install_on_ubuntu_direct.sh"
