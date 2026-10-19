#!/bin/sh
# Backend entrypoint: apply DB migrations, then exec the server.
set -e

echo "[entrypoint] Applying database migrations"
node_modules/.bin/tsx server/scripts/database.ts migrate

echo "[entrypoint] Starting: $*"
exec "$@"
