FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io tar ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin traceomics
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./backend
USER 10001:10001
ENTRYPOINT ["node", "backend/expertSandboxBroker.js"]
