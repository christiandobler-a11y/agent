#!/bin/sh
# Vor dem Start neue Migrationen anwenden (idempotent). Mit SKIP_MIGRATE=1 abschaltbar.
set -e
if [ "${SKIP_MIGRATE:-0}" != "1" ] && [ "$1" = "node" ] && [ "$2" = "dist/main.js" ]; then
  node dist/cli.js migrate
fi
exec "$@"
