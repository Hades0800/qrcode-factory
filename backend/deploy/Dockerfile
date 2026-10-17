# syntax=docker/dockerfile:1
# 後端容器映像（Cloud Run 等容器平台用）
# 放在 deploy/ 而非 backend/ 根目錄：Zeabur 偵測到根目錄的 Dockerfile 會自動改用 Docker 建置，
# 這裡不影響 Zeabur 現行的 Node 建置方式。
#
# 建置（在 backend/ 目錄）：docker build -f deploy/Dockerfile -t qrcode-backend .
# 執行：docker run -p 8080:8080 -e DATABASE_URL=... -e JWT_SECRET=... qrcode-backend

ARG NODE_VERSION=22

# ── 建置階段：安裝全部依賴並產生 Prisma Client ──
FROM node:${NODE_VERSION}-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall 會執行 prisma generate，依建置平台（amd64/arm64）產生對應的查詢引擎
RUN npm ci

# ── 執行階段：只放正式環境需要的依賴 ──
FROM node:${NODE_VERSION}-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts：正式依賴不含 prisma CLI，postinstall 的 prisma generate 會失敗；
# 改從建置階段複製已產生好的 Prisma Client
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY data ./data
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
