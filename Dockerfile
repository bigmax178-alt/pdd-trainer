# API-сервер. Runtime-зависимостей нет: TypeScript исполняется Node.js напрямую.
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 DATA_FILE=/data/db.json
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1
CMD ["node", "src/server/main.ts"]
