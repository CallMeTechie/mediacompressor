# MediaCompressor

Self-hosted media-compression service. Drag-and-drop upload (TUS resumable),
asynchronous compression pipeline (ffmpeg + libvips/libheif), browser-based
admin UI with i18n (DE/EN), and persistent audit trail.

## Quick Start (Development)

Requirements: Docker + Docker Compose v2.24+, Node.js 22+, pnpm 9+.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm --filter @mediacompressor/db prisma:migrate:deploy
pnpm dev
```

Service is reachable on `http://localhost:3000`.

## Production Deployment

See the production overlay:

```bash
cp .env.production.example .env.production
# Edit .env.production with real secrets (Postgres password, API_KEY_PEPPER, etc.)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Caddy auto-issues TLS via Let's Encrypt. See the production `.env.example`
file for required secrets and rotation guidance.

## Container Images

Pre-built images on GitHub Container Registry:

- `ghcr.io/callmetechie/mediacompressor-api:latest`
- `ghcr.io/callmetechie/mediacompressor-worker:latest`

## Tech Stack

- **API**: Fastify 5 + HTMX + Handlebars + Prisma 5 + Postgres 16
- **Worker**: BullMQ + Redis + ffmpeg + sharp (libvips/libheif)
- **Upload**: tusd (TUS protocol, resumable uploads)
- **Reverse-Proxy**: Caddy 2 (auto-TLS, security headers)
- **i18n**: i18next + fs-backend (DE/EN, full RTL-ready)

## Contributions

This repository accepts no external contributions at this time. Issues are
welcome at https://github.com/CallMeTechie/mediacompressor/issues. Pull
requests from forks will not be merged — please open an issue describing
what you'd build, and the maintainer will scope it.

## License

MIT — see `LICENSE`.
