# Monorepo-aware build. Build context must be the repo root so we can
# copy the sibling `packages/types/` workspace referenced via
# `file:../packages/types` in package.json.
#
# docker-compose:
#   build:
#     context: .
#     dockerfile: shared-orderbook/Dockerfile

# Stage 1: Build
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Build the shared types package first so its dist/ exists when the
# consumer runs `npm ci` below (consumers install the types package
# as a file: dependency; the `prepare` script ensures types/dist exists
# even in isolated installs).
COPY packages/types/ /packages/types/
WORKDIR /packages/types
RUN npm install --include=dev && npm run build

WORKDIR /app
COPY shared-orderbook/package*.json ./
RUN npm ci
COPY shared-orderbook/ ./
RUN npm run build

# Stage 2: Production — carry over node_modules from builder to avoid
# reinstalling native modules (better-sqlite3) and re-running prepare.
FROM node:20-slim
COPY --from=builder /packages/types/ /packages/types/
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV PORT=4000
EXPOSE ${PORT}

CMD ["node", "dist/index.js"]
