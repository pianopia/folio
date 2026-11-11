FROM oven/bun:1.2.20 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN bun run build
RUN bun build apps/api/src/index.ts --target=bun --external '@libsql/client' --outfile=/app/server/index.js

FROM oven/bun:1.2.20 AS runtime-deps
WORKDIR /runtime
COPY apps/api/runtime-package.json ./package.json
RUN bun install --production

FROM oven/bun:1.2.20 AS runner
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=runtime-deps /runtime/node_modules ./node_modules
COPY --from=runtime-deps /runtime/package.json ./package.json
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist
USER bun
EXPOSE 8080
CMD ["bun", "server/index.js"]
