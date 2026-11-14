# 真实 worker 骨架镜像：零依赖，只需要 Node 20 运行时。
FROM node:20-slim

WORKDIR /app
COPY worker/real/ ./
RUN chown -R node:node /app
USER node

# worker 是轮询循环、没有 HTTP 端口，不设 HEALTHCHECK（容器存活即进程存活）
CMD ["node", "index.mjs"]
