# Monorepo-aware build. Context = repo root; see docker-compose.yml.

FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY packages/types/ /packages/types/
WORKDIR /packages/types
RUN npm ci --include=dev && npm run build

# `@zkscatter/sdk` is a `file:../packages/sdk` dependency in
# zk-relayer/package.json. Copy the SDK source into the image at the
# expected sibling path so `npm ci` below can resolve the file: link.
# The SDK is TS-only (`exports` point to `./src/*.ts`) and the runtime
# entrypoint below is `npx tsx`, which loads .ts directly — no SDK
# build step is needed inside the image.
COPY packages/sdk/ /packages/sdk/

WORKDIR /app
COPY zk-relayer/package*.json ./
# `--install-links` copies file:-protocol deps into `/app/node_modules`
# instead of symlinking. Without it, Node follows the realpath when
# resolving SDK imports and walks `/packages/sdk/node_modules` ->
# `/packages/node_modules` -> `/node_modules` — none of which contain
# the SDK's runtime deps (`@noble/*`, `snarkjs`, `circomlibjs`,
# `ethers`), and the container fails at first import with
# MODULE_NOT_FOUND.
RUN npm ci --install-links --include=dev
COPY zk-relayer/ ./

ENV PORT=3002
EXPOSE ${PORT}

CMD ["npx", "tsx", "src/index.ts"]
