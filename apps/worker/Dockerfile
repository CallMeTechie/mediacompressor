# Worker-Container für die Compression-Engine.
# Plan 4 ergänzt CMD, COPY und das Workspace-Setup.
# Plan 2 hinterlegt System-Deps (Runtime + Build) für HEIC/HEVC-Encoding via
# sharp build-from-source (Plan 2 Task 4-bis). Ohne diese Build-Toolchain
# liefert sharp's prebuilt-libvips kein HEVC-Encoder und tiny.heic-Generation
# scheitert.

FROM node:22-bookworm-slim AS base

# Runtime + Build deps für ffmpeg + libvips + libheif (mit x265, aom, dav1d, de265 codecs)
# + sharp build-from-source toolchain (build-essential, python3, node-gyp deps).
# NOTE: Debian bookworm ships libheif 1.15.1 (monolithic build) — codecs are linked
# directly into libheif1 via deps (libde265-0, libx265-199, libaom3, libdav1d6).
# The plugin-directory architecture (libheif-plugin-*) was introduced in libheif 1.16+
# and is not available in bookworm main. The codec shared-objects below are the
# bookworm-equivalent of the plugin packages called for in the Rev.5 spec.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      libvips42 \
      libvips-dev \
      libvips-tools \
      libheif1 \
      libheif-dev \
      libde265-0 \
      libx265-199 \
      libaom3 \
      libdav1d6 \
      build-essential \
      python3 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# sharp baut from-source gegen system-libvips, damit HEIC-Encoder verfügbar ist.
# Ohne diese ENV nutzt sharp prebuilt-libvips ohne HEVC-Encoder.
ENV SHARP_FORCE_GLOBAL_LIBVIPS=true

# Smoke: Versionen melden, sodass `docker build` einen sichtbaren Beweis hinterlässt.
# libheif 1.15.1 (bookworm) ist monolithisch: Codec-SOs werden als Beweis gelistet.
RUN ffmpeg -version | head -n 1 \
 && vips --version 2>/dev/null \
 && ls /usr/lib/x86_64-linux-gnu/libheif.so* \
       /usr/lib/x86_64-linux-gnu/libx265.so* \
       /usr/lib/x86_64-linux-gnu/libaom.so* \
       /usr/lib/x86_64-linux-gnu/libdav1d.so* \
       /usr/lib/x86_64-linux-gnu/libde265.so* \
 && echo "Worker base image ready"

# Plan 4 ergänzt von hier ab: WORKDIR, COPY, pnpm install, CMD
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node tsconfig.base.json tsconfig.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/worker ./apps/worker
RUN corepack enable && corepack prepare pnpm@9 --activate \
 && chown -R node:node /app \
 && su node -c "pnpm install --frozen-lockfile \
    && pnpm --filter @mediacompressor/db prisma:generate \
    && pnpm --filter @mediacompressor/worker build"
USER node
CMD ["node", "apps/worker/dist/index.js"]
