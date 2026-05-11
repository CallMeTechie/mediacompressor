# syntax=docker/dockerfile:1.7
#
# Stage 1: builder — installs all deps (incl. dev-deps for tsc + prisma:generate)
# and produces the compiled apps/api/dist + prisma-generated client.
FROM node:22-bookworm-slim AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN corepack enable && corepack prepare pnpm@9 --activate \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @mediacompressor/db prisma:generate \
 && pnpm --filter '@mediacompressor/api...' build

# Stage 2: runtime — slim image with the EXISTING node_modules from builder
# (no --prod re-install, no risk of rebuild surprises). The extra dev-deps
# are ~30-50 MB total (no native artifacts to re-link); the win from
# dropping build-toolchain is the primary Multi-Stage optimization.
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=node:node /app/apps/api/views ./apps/api/views
COPY --from=builder --chown=node:node /app/apps/api/locales ./apps/api/locales
COPY --from=builder --chown=node:node /app/apps/api/public ./apps/api/public
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
