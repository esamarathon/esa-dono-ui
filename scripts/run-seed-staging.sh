#!/bin/bash
# Script to run the Prisma seed on the staging server (oci-public)
#
# Usage:
#   ./scripts/run-seed-staging.sh [container-name]
#
# Defaults to 'esa-dono-ui-dono-backend-1' (the container name docker compose
# assigns based on the project directory name on oci-public).
#
# The runtime image has no npm/npx (stripped from the image to stay slim), so
# this invokes tsx directly against node_modules/.bin rather than going
# through `npx prisma db seed`.
#
# Prerequisites:
#   - Run from a machine with SSH/docker access to the target host, or
#     directly on the host itself
#   - Docker must be running and the named container must be up

set -e

CONTAINER_NAME="${1:-esa-dono-ui-dono-backend-1}"

echo "🌱 Running Prisma seed on staging server"
echo "Container: $CONTAINER_NAME"
echo ""

docker exec -w /app/server "$CONTAINER_NAME" sh -c '/app/node_modules/.bin/tsx prisma/seed.ts'

echo ""
echo "✅ Seed completed successfully!"
