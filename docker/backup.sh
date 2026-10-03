#!/bin/sh
# Sichert die Avelio-Tabellen (Schema public) als komprimierten Dump und behält 14 Tage.
# Wiederherstellen: siehe docs/DEPLOY.md, Abschnitt "Sicherung".
set -eu
: "${DATABASE_URL:?DATABASE_URL fehlt}"
file="/backups/avelio-$(date +%Y-%m-%d_%H%M).dump"
pg_dump --format=custom --schema=public --no-owner --no-privileges --file="$file" "$DATABASE_URL"
find /backups -name 'avelio-*.dump' -mtime +14 -delete
echo "Sicherung geschrieben: $file ($(du -h "$file" | cut -f1))"
