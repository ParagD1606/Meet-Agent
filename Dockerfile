FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile || bun install
COPY web web
RUN cd web && bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --production --frozen-lockfile || bun install --production
COPY server server
COPY --from=build /app/web/dist web/dist
ENV WEB_DIST=/app/web/dist
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD bun -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/src/index.ts"]
