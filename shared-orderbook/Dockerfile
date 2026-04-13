# Monorepo-aware build. Context = repo root; see docker-compose.yml.

# Stage 1: Build
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY packages/types/ /packages/types/
WORKDIR /packages/types
RUN npm ci --include=dev && npm run build

WORKDIR /app
COPY shared-orderbook/package*.json ./
RUN npm ci
COPY shared-orderbook/ ./
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Runtime. Carry pruned node_modules from builder to avoid
# reinstalling native modules (better-sqlite3) and re-running lifecycle
# scripts that would pull devDeps back in.
FROM node:20-slim
COPY --from=builder /packages/types/ /packages/types/
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /app /data /packages

USER node
ENV PORT=4000
EXPOSE ${PORT}

CMD ["node", "dist/index.js"]
