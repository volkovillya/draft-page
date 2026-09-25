# syntax=docker/dockerfile:1
#
# DraftPage production image (Phase 2). Three stages:
#   deps    → exact dependency install from package-lock.json (cached until it changes)
#   build   → next build (standalone output); no secrets, no .env files (see .dockerignore)
#   runtime → only the standalone server, static assets, migrations and the migration runner,
#             running as the non-root `node` user.
# Build for Fargate ARM64:  docker build --platform linux/arm64 -t draftpage .

ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # Trust the Amazon RDS CAs, so DRAFTPAGE_DATABASE_SSL=verify-full can check the server.
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem

# Public certificate bundle for RDS (not a secret). Downloaded at build time.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /tmp/rds-global-bundle.pem
RUN install -D -m 444 /tmp/rds-global-bundle.pem /app/certs/rds-global-bundle.pem && rm /tmp/rds-global-bundle.pem

# The app: root-owned and read-only for the runtime user; only the Next cache is writable.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p .next/cache && chown node:node .next/cache

# The migration runner, run as a one-off task: `node migrate/src/server/db/migrate.ts`.
# Only its two runtime packages are copied (neither has dependencies of its own).
COPY --from=deps /app/node_modules/drizzle-orm ./migrate/node_modules/drizzle-orm
COPY --from=deps /app/node_modules/postgres ./migrate/node_modules/postgres
COPY --from=build /app/src/server/db/migrate.ts /app/src/server/db/env-config.ts ./migrate/src/server/db/
COPY --from=build /app/drizzle ./migrate/drizzle

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Next.js listens on the address in HOSTNAME. Platforms such as ECS Fargate overwrite
# HOSTNAME with the task's own name, which would make it listen on that address only (and
# fail health checks on 127.0.0.1), so pin it here. `exec` keeps node as the signal target.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
