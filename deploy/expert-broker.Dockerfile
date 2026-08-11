FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io tar ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./backend
USER root
ENTRYPOINT ["node", "backend/expertSandboxBroker.js"]
