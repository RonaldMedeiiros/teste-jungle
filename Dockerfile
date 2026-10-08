FROM oven/bun:1.1.38-debian

WORKDIR /app

COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV HTTP_PORT=3000

EXPOSE 3000

CMD ["bun", "run", "src/main.ts"]
