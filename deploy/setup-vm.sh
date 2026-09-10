#!/usr/bin/env bash
# One-shot setup for a fresh Debian/Ubuntu VM (Google Cloud e2-micro, Oracle Always Free, any VPS).
# Installs Docker, starts the dashboard behind Caddy with automatic HTTPS, and keeps it running on reboot.
#
# Usage, on the VM:
#   git clone <your repo url> fantasy-dashboard
#   cd fantasy-dashboard/deploy
#   DOMAIN=yourname.duckdns.org FHQ_PASSWORD='choose-a-password' ./setup-vm.sh
#
# Before running: point DOMAIN at this VM's public IP (DuckDNS is free: https://www.duckdns.org),
# and open TCP ports 80 and 443 in the cloud firewall.
set -euo pipefail

if [[ -z "${DOMAIN:-}" || -z "${FHQ_PASSWORD:-}" ]]; then
  echo "Set DOMAIN and FHQ_PASSWORD, e.g.:  DOMAIN=me.duckdns.org FHQ_PASSWORD='secret' ./setup-vm.sh" >&2
  exit 1
fi

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "== Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi

echo "== Writing deploy/.env"
cat > .env <<EOF
DOMAIN=${DOMAIN}
FHQ_PASSWORD=${FHQ_PASSWORD}
EOF
chmod 600 .env

echo "== Building and starting"
sudo docker compose up -d --build

echo
echo "Done. Give Caddy a minute to fetch the certificate, then open: https://${DOMAIN}"
echo "Update later with:  git pull && sudo docker compose up -d --build"
