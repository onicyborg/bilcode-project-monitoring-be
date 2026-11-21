# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.33.1
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.33.1
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4100
# Prisma CLI is retained for the one-off migration before the API is replaced.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts /app/package.json /app/pnpm-lock.yaml ./
COPY docs/humanizer-zh/LICENSE ./licenses/humanizer-zh/LICENSE
USER node
EXPOSE 4100
CMD ["node", "dist/main.js"]
