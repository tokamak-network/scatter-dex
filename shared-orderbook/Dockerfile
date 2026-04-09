FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV PORT=4000
EXPOSE ${PORT}

CMD ["npx", "tsx", "src/index.ts"]
