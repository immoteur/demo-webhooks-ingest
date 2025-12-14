FROM node:20-alpine AS build

WORKDIR /app

# Build deps for node-gyp (some dev deps bring optional native bindings)
RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:20-alpine AS prod-deps

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/db/migrations ./dist/db/migrations
COPY --from=build --chown=node:node /app/scripts ./scripts

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
