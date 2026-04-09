FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .

ENV PORT=4000
EXPOSE ${PORT}

CMD ["npx", "tsx", "src/index.ts"]
