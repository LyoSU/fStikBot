FROM node:lts-alpine AS base

FROM base AS builder
WORKDIR /install
# The lockfile pins the exact tree; `npm i` without it resolved fresh versions
# on every build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base
RUN addgroup -S bot && adduser -S bot -G bot
WORKDIR /app
# Owned by the runtime user: the bot writes .mtproto-session and
# .locale-sync-mtime next to the code, and a root-owned /app made both fail.
COPY --from=builder --chown=bot:bot /install/node_modules ./node_modules
COPY --chown=bot:bot . .
# sharp and fs share libuv's pool (default 4); same value as ecosystem.config.js.
ENV UV_THREADPOOL_SIZE=16
USER bot
CMD ["node", "index.js"]
