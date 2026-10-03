#!/usr/bin/env bash
# Neueste Version holen und Avelio neu starten. Auf dem Server ausführen: bash /opt/avelio/scripts/deploy.sh
set -euo pipefail
cd /opt/avelio
git pull --ff-only
docker compose -f docker-compose.prod.yml up -d --build
docker image prune -f >/dev/null
sleep 5
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 5 app
