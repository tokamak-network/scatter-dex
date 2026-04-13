# Monorepo-aware build. Build context must be the repo root so we can
# copy the sibling `packages/types/` workspace referenced via
# `file:../packages/types` in package.json.
#
# The layout inside the container mirrors the repo: `/packages/types`
# sits one level above `/app`, so the `file:../packages/types` path in
# the workspace package.json resolves correctly.
#
# docker-compose:
#   build:
#     context: .
#     dockerfile: zk-relayer/Dockerfile

FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Build the shared types package first so its dist/ exists when we
# install the zk-relayer package below.
COPY packages/types/ /packages/types/
WORKDIR /packages/types
RUN npm install --include=dev && npm run build

WORKDIR /app
COPY zk-relayer/package*.json ./
RUN npm ci --production=false
COPY zk-relayer/ ./

ENV PORT=3002
EXPOSE ${PORT}

CMD ["npx", "tsx", "src/index.ts"]
