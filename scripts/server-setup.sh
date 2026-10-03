#!/usr/bin/env bash
# Einmalige Einrichtung eines frischen Hetzner-Servers (Ubuntu 24.04) für Avelio. Als root ausführen:
#   bash server-setup.sh
# Mehrfach ausführbar: bereits Erledigtes wird übersprungen. Anleitung: docs/DEPLOY.md
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte als root ausführen." >&2
  exit 1
fi

echo "==> System aktualisieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q ca-certificates curl git ufw unattended-upgrades

echo "==> Automatische Sicherheitsupdates"
dpkg-reconfigure -f noninteractive unattended-upgrades

if ! command -v docker >/dev/null; then
  echo "==> Docker installieren (offizielles Paket-Repository)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "==> Firewall: nur SSH von außen (der Telegram-Bot fragt selbst nach, braucht keinen offenen Port)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
# Vorschau-Seiten (Caddy, HTTPS); ohne laufenden Caddy-Dienst antwortet dort niemand.
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

if ! swapon --show | grep -q .; then
  echo "==> 2 GB Auslagerungsspeicher (Reserve für Chromium)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >>/etc/fstab
fi

echo "==> Tägliche Datenbank-Sicherung um 03:15 (Server-Zeit)"
cat >/etc/cron.d/avelio-backup <<'CRON'
15 3 * * * root cd /opt/avelio && docker compose -f docker-compose.prod.yml run --rm backup >>/var/log/avelio-backup.log 2>&1
CRON

KEY=/root/.ssh/avelio_deploy
if [ ! -f "$KEY" ]; then
  echo "==> Schlüssel zum Lesen des GitHub-Repos anlegen"
  mkdir -p /root/.ssh
  ssh-keygen -t ed25519 -N "" -C "avelio-server" -f "$KEY" >/dev/null
  cat >>/root/.ssh/config <<SSH
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
SSH
  ssh-keyscan -t ed25519 github.com >>/root/.ssh/known_hosts 2>/dev/null
fi

echo
echo "Fertig. Nächster Schritt (docs/DEPLOY.md, Schritt 4): diesen Schlüssel bei GitHub als Deploy Key eintragen"
echo "(Repo → Settings → Deploy keys → Add deploy key, NICHT \"Allow write access\" anhaken):"
echo
cat "$KEY.pub"
