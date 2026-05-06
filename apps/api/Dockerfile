FROM node:22-bookworm-slim
# Prisma's query engine for debian-openssl-1.1.x dynlinks against libssl.so.1.1.
# node:22-bookworm-slim ships without libssl, so install it explicitly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node tsconfig.base.json tsconfig.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/api ./apps/api
RUN corepack enable && corepack prepare pnpm@9 --activate \
 && chown -R node:node /app \
 && su node -c "pnpm install --frozen-lockfile \
    && pnpm --filter @mediacompressor/db prisma:generate \
    && pnpm --filter @mediacompressor/api build"
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
