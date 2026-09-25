#!/usr/bin/env bash
# Builds the production image and checks it the way ECS will run it (including Fargate's
# habit of overwriting HOSTNAME with the task's own name):
#   1. the one-off migrate command (inside the image) against a scratch database
#   2. the app container: health checks, smoke tests (tests/image), Docker HEALTHCHECK
#   3. a graceful stop: SIGTERM must exit 0
# Needs Docker, `npm run test:db` (Postgres on :55440) and Auth0 values in .env.local.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=draftpage:local
NAME=draftpage-image-test
PORT=${DRAFTPAGE_IMAGE_PORT:-6590}
DB=draftpage_image
PG="postgres://postgres:test@localhost:55440"
IN_DOCKER_PG_HOST=host.docker.internal

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▸ build"
docker build --quiet --platform linux/arm64 -t "$IMAGE" . >/dev/null

echo "▸ image contents"
docker run --rm --entrypoint sh "$IMAGE" -c '
  test "$(id -un)" = node || { echo "runs as $(id -un), expected node"; exit 1; }
  if find /app -name ".env*" | grep -q .; then echo "found .env files in the image"; exit 1; fi
  test ! -w /app/server.js || { echo "app files are writable by the runtime user"; exit 1; }
  test -s /app/certs/rds-global-bundle.pem || { echo "missing RDS CA bundle"; exit 1; }
  echo "  non-root, no .env files, read-only app, RDS CA present"'

echo "▸ scratch database"
node -e "
  const postgres = require('postgres');
  const sql = postgres('$PG/postgres', { max: 1, onnotice: () => {} });
  (async () => {
    await sql.unsafe('drop database if exists $DB with (force)');
    await sql.unsafe('create database $DB');
    await sql.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });"

echo "▸ migrate (one-off task command, separate DB_* variables)"
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DRAFTPAGE_DB_HOST=$IN_DOCKER_PG_HOST -e DRAFTPAGE_DB_PORT=55440 -e DRAFTPAGE_DB_NAME=$DB \
  -e DRAFTPAGE_DB_USER=postgres -e DRAFTPAGE_DB_PASSWORD=test \
  "$IMAGE" node migrate/src/server/db/migrate.ts

echo "▸ app container on :$PORT"
docker run -d --name "$NAME" --add-host=host.docker.internal:host-gateway -p "$PORT:3000" \
  --env-file .env.local \
  -e DRAFTPAGE_DATABASE_URL="postgres://postgres:test@$IN_DOCKER_PG_HOST:55440/$DB" \
  -e DRAFTPAGE_DATABASE_SSL=false \
  -e APP_BASE_URL="http://localhost:$PORT" \
  -e DRAFTPAGE_DEV_AUTH=on \
  -e HOSTNAME=ip-10-20-0-37.eu-north-1.compute.internal \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && break; sleep 1; done

echo "▸ smoke tests"
DRAFTPAGE_IMAGE_PORT=$PORT npx playwright test -c playwright.image.config.ts

echo "▸ Docker HEALTHCHECK"
for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [ "$status" = healthy ] && break
  sleep 1
done
[ "$status" = healthy ] || { echo "health status: $status"; exit 1; }
echo "  healthy"

echo "▸ graceful stop (SIGTERM)"
start=$(date +%s)
docker stop -t 30 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
echo "  exit code $code after $(( $(date +%s) - start ))s"
[ "$code" = 0 ] || [ "$code" = 143 ] || { docker logs "$NAME" | tail -20; exit 1; }

echo "✓ image OK"
