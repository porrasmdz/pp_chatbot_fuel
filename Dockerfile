FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production APP_DATA_DIR=/data
LABEL org.opencontainers.image.source="https://github.com/porrasmdz/pp_chatbot_fuel"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/probar-alertas.js ./scripts/probar-alertas.js
COPY scripts/reintentar-respaldos.js ./scripts/reintentar-respaldos.js

CMD ["node", "dist/index.js"]
