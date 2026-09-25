#!/usr/bin/env bash
# Starts (or reuses) a disposable Postgres 18 for the test suite on host port 55440.
set -euo pipefail

NAME=draftpage-test-pg
PORT=55440

if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = "true" ]; then
  echo "Reusing running container $NAME"
else
  # A stopped leftover container is removed so we always start clean.
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=draftpage_test \
    -p "$PORT:5432" \
    postgres:18-alpine >/dev/null
  echo "Started container $NAME on port $PORT"
fi

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d draftpage_test >/dev/null 2>&1; then
    # pg_isready can pass during the init-time restart; confirm with a real query.
    if docker exec "$NAME" psql -U postgres -d draftpage_test -c 'select 1' >/dev/null 2>&1; then
      echo "Test database ready: postgres://postgres:test@localhost:$PORT/draftpage_test"
      exit 0
    fi
  fi
  sleep 1
done
echo "Timed out waiting for $NAME to accept connections" >&2
exit 1
