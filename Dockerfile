FROM node:18-alpine

# Устанавливаем bash и другие утилиты
RUN apk add --no-cache bash docker curl

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем исходный код
COPY . .

# Порт приложения (измените, если у вас другой)
EXPOSE 3000

# Запуск сервера
CMD ["node", "server.js"]
