# syntax=docker/dockerfile:1

# One image runs both the web server and the worker (see docker/entrypoint.sh).

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Dependencies come first, so a change to the code does not reinstall them.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
# Hosts allowed to call Server Actions beyond the one the browser used. Usually empty.
# It is read while the app is built, so changing it means rebuilding the image.
ARG ALLOWED_ORIGINS=""
ENV ALLOWED_ORIGINS=$ALLOWED_ORIGINS \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Builds the web server (.next/standalone) and the worker and CLI bundles (dist/).
RUN pnpm build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node docker/entrypoint.sh /entrypoint.sh

# Nothing here needs root.
USER node
EXPOSE 3000

# /api/health answers without a login and says only whether the database is reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["web"]
