# syntax=docker/dockerfile:1.7
#
# Stage 1: builder — full toolchain (libvips-dev, libheif-dev, build-essential,
# python3) for sharp build-from-source against system-libvips.
FROM node:22-trixie-slim AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      libvips42t64 \
      libvips-dev \
      libvips-tools \
      libheif1 \
      libheif-dev \
      libde265-0 \
      libx265-215 \
      libaom3 \
      libdav1d7 \
      build-essential \
      python3 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV SHARP_FORCE_GLOBAL_LIBVIPS=true
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN corepack enable && corepack prepare pnpm@9 --activate \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @mediacompressor/db prisma:generate \
 && pnpm --filter '@mediacompressor/worker...' build

# Stage 2: runtime — runtime libs only (NO -dev, NO build-essential, NO python3).
# WC-cicd-17: node_modules wird DIREKT vom builder kopiert — KEIN --prod
# re-install, der sharp's gebauten sharp-linux-x64.node aus dem ersten
# pnpm install gefährden würde.
FROM node:22-trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      libvips42t64 \
      libheif1 \
      libde265-0 \
      libx265-215 \
      libaom3 \
      libdav1d7 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV SHARP_FORCE_GLOBAL_LIBVIPS=true
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
USER node
CMD ["node", "apps/worker/dist/index.js"]
