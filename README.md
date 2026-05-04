# MediaCompressor

Self-hosted Service zur Kompression von Bild- und Videodateien (Web-UI + REST-API).

## Status

**Foundation-Phase abgeschlossen.** Repository ist auf alle nachfolgenden Pläne (Compression Engine, Auth, Job-Lifecycle, …) vorbereitet.

Siehe [`docs/superpowers/specs/2026-05-03-mediacompressor-design.md`](./docs/superpowers/specs/2026-05-03-mediacompressor-design.md) für die vollständige Spezifikation und [`docs/superpowers/plans/`](./docs/superpowers/plans/) für die Implementierungspläne.

## Voraussetzungen

- Node 22 LTS (`.nvmrc`)
- pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- Docker + Compose v2

## Erste Schritte

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
docker compose run --rm migrate
pnpm test
pnpm lint
pnpm typecheck
```

## Repository-Struktur

| Pfad | Inhalt |
|---|---|
| `packages/shared` | Geteilte Typen, Zod-Schemas, Error-Codes |
| `packages/storage` | StorageAdapter-Interface (Plan 2: LocalFsAdapter) |
| `packages/compression` | CompressionRequest/Result + Profile-Allowlist (Plan 2: sharp/ffmpeg-Engines) |
| `packages/db` | Prisma-Schema und Client-Factory |
| `packages/eslint-plugin-mediacompressor` | Custom-Rule `no-direct-ffmpeg-spawn` (Spec C2) |
| `apps/api` | Plan 4 — Fastify-Server |
| `apps/worker` | Plan 4 — BullMQ-Job-Consumer |
| `apps/web` | Plan 8 — React-Frontend |
| `docs/` | Spezifikationen, Pläne, Prompts |
