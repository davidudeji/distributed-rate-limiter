FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src/        ./src/
COPY migrations/ ./migrations/
COPY public/     ./public/


EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
