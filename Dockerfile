# ---------- build stage ----------
FROM node:20 AS build
WORKDIR /build
COPY client/ ./client/
RUN cd client && npm install && npm run build
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# ---------- runtime stage ----------
FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    TZ=Asia/Shanghai
WORKDIR /app
COPY --from=build /build/client/dist ./client/dist
COPY server/ ./server/
# node_modules 必须最后从构建阶段拷入，覆盖源码目录可能带入的本地模块，
# 保证原生模块（如 better-sqlite3）与镜像内 Node 版本一致
COPY --from=build /build/server/node_modules ./server/node_modules
COPY worker/ ./worker/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
