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

RUN apk add --no-cache dumb-init openssl

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src/database/prisma ./src/database/prisma

RUN mkdir -p /app/logs && \
    chown -R node:node /app/logs && \
    chmod 755 /app/logs && \
    chown -R node:node /app/node_modules && \
    chown -R node:node /app/dist

ENV NODE_ENV=production

EXPOSE 3000

# Run migrations as root, then start app as node user
CMD ["sh", "-c", "npx prisma migrate deploy --skip-generate && su -s /bin/sh node -c 'dumb-init node dist/server.js'"]
