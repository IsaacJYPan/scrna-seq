# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm ci --prefer-offline --no-audit --no-fund

COPY . .
RUN npm run build \
    && npm prune --omit=dev --no-audit --no-fund

# On-demand operations image. It combines the exact PostgreSQL 16 client with
# the production Node dependencies, but is not used by the network-facing web or
# worker services. Its entrypoint accepts one of the reviewed operations scripts.
FROM postgres:16-bookworm AS operations

ARG APP_UID=10001
ARG APP_GID=10001

ENV NODE_ENV=production \
    HOME=/home/appuser

WORKDIR /app

COPY --from=build /usr/local/ /usr/local/
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend ./backend
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts/backup-runtime.js ./scripts/backup-runtime.js
COPY --from=build /app/scripts/restore-runtime.js ./scripts/restore-runtime.js
COPY --from=build /app/scripts/verify-backup-restore.js ./scripts/verify-backup-restore.js
COPY --from=build /app/scripts/verify-backup-restore-drill.js ./scripts/verify-backup-restore-drill.js
COPY --from=build /app/scripts/account-admin.js ./scripts/account-admin.js
COPY --from=build /app/scripts/manage-platform-developer.js ./scripts/manage-platform-developer.js

RUN groupadd --gid "${APP_GID}" appuser \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home \
      --shell /usr/sbin/nologin appuser \
    && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0750 \
      /app/storage-volume /app/storage-volume/data \
      /app/vault-volume /app/vault-volume/vault /app/backups

USER appuser

ENTRYPOINT ["node"]
CMD ["scripts/backup-runtime.js", "--help"]

FROM ${NODE_IMAGE} AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

ENV NODE_ENV=production \
    HOME=/home/appuser

WORKDIR /app

RUN groupadd --gid "${APP_GID}" appuser \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home \
      --shell /usr/sbin/nologin appuser \
    && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0750 \
      /app/storage-volume /app/storage-volume/data \
      /app/vault-volume /app/vault-volume/vault /app/scripts

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend ./backend
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.js /app/worker.js ./
COPY --from=build /app/scripts/enable-job-worker.cjs ./scripts/enable-job-worker.cjs
COPY --from=build /app/scripts/init-postgres.js ./scripts/init-postgres.js
COPY --from=build /app/scripts/init-production-database.js ./scripts/init-production-database.js
COPY --from=build /app/scripts/manage-platform-developer.js ./scripts/manage-platform-developer.js
COPY --from=build /app/scripts/account-admin.js ./scripts/account-admin.js
COPY --from=build /app/scripts/backup-runtime.js ./scripts/backup-runtime.js
COPY --from=build /app/scripts/restore-runtime.js ./scripts/restore-runtime.js
COPY --from=build /app/scripts/verify-backup-restore.js ./scripts/verify-backup-restore.js
COPY --from=build /app/scripts/cleanup-demo-guests.js ./scripts/cleanup-demo-guests.js
COPY --from=build /app/scripts/bootstrap-demo-template.js ./scripts/bootstrap-demo-template.js

USER appuser

EXPOSE 3000 3101
STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
