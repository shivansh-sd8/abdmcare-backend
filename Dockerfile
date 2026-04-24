FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY src/database/prisma ./src/database/prisma/

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init && \
    mkdir -p /app/logs && \
    chmod 755 /app/logs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src/database/prisma ./src/database/prisma

ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["dumb-init", "node", "dist/server.js"]
