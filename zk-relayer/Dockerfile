# Monorepo-aware build. Context = repo root; see docker-compose.yml.

FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY packages/types/ /packages/types/
WORKDIR /packages/types
RUN npm ci --include=dev && npm run build

WORKDIR /app
COPY zk-relayer/package*.json ./
RUN npm ci --production=false
COPY zk-relayer/ ./

ENV PORT=3002
EXPOSE ${PORT}

CMD ["npx", "tsx", "src/index.ts"]
