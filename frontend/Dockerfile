FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
EXPOSE 3000
CMD ["npx", "next", "dev"]
