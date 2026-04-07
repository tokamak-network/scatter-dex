# Local development image — uses next dev for runtime env var injection.
# next build inlines NEXT_PUBLIC_* at build time, incompatible with
# Docker runtime config via addresses.env.
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npx", "next", "dev"]
