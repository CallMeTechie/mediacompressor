# Worker-Container für die Compression-Engine.
# Plan 4 ergänzt CMD, COPY und das Workspace-Setup.
# Plan 2 hinterlegt System-Deps (Runtime + Build) für HEIC/HEVC-Encoding via
# sharp build-from-source (Plan 2 Task 4-bis). Ohne diese Build-Toolchain
# liefert sharp's prebuilt-libvips kein HEVC-Encoder und tiny.heic-Generation
# scheitert.
#
# Plan 4 Task 12 follow-up: Switch von bookworm-slim → trixie-slim. bookworm
# shippt libvips 8.14.1, aber sharp 0.33.5 mit SHARP_FORCE_GLOBAL_LIBVIPS=true
# verlangt mindestens libvips 8.15.3 (Plan-2-Latenz: Plan 2's Worker-Dockerfile
# führte nie ein echtes pnpm install aus, daher unentdeckt). Trixie shippt
# libvips 8.16.x. Alle apt-Paket-Namen bleiben identisch (verifiziert in trixie/main).
# Codec-Suffix `libx265-199` → `libx265-215` (Trixie ships x265 4.x mit ABI 215).

FROM node:22-trixie-slim AS base

# Runtime + Build deps für ffmpeg + libvips + libheif (mit x265, aom, dav1d, de265 codecs)
# + sharp build-from-source toolchain (build-essential, python3, node-gyp deps).
# Trixie shippt libheif 1.17+ mit Plugin-Architektur, aber wir behalten die
# monolithischen Codec-SOs (libde265, libx265, libaom, libdav1d) — sie sind
# weiterhin als shared libs verfügbar und decken HEIC/HEVC + AVIF ab.
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

# sharp baut from-source gegen system-libvips, damit HEIC-Encoder verfügbar ist.
# Ohne diese ENV nutzt sharp prebuilt-libvips ohne HEVC-Encoder.
ENV SHARP_FORCE_GLOBAL_LIBVIPS=true

# Smoke: Versionen melden, sodass `docker build` einen sichtbaren Beweis hinterlässt.
# Trixie: libvips 8.16.x, libheif 1.17+. Codec-SOs werden weiterhin gelistet.
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
