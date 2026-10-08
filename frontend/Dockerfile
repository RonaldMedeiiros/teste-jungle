FROM oven/bun:1.1.38-debian

WORKDIR /app

COPY server.ts index.html ./

ENV FRONTEND_PORT=8080

EXPOSE 8080

CMD ["bun", "run", "server.ts"]
