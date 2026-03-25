# Stage 1: сборка зависимостей
FROM node:18-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=optional
COPY . .

# Stage 2: финальный минимальный образ
FROM node:18-slim
RUN apt-get update && apt-get install -y --no-install-recommends libvips && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .
CMD ["node", "server.js"]
