# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=24024

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mcpfs

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=builder /build/dist ./dist

RUN mkdir -p /srv/obsidian/vault \
    && chown -R node:node /opt/mcpfs /srv/obsidian

USER node

EXPOSE 24024

ENTRYPOINT ["node", "/opt/mcpfs/dist/index.js"]
CMD ["/srv/obsidian/vault"]
