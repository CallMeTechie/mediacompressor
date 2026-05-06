# E2E Smoke-Tests

Operator-run integration tests that exercise the **full compose stack**
(api + worker + tusd + postgres + redis). They are intentionally NOT picked
up by `vitest run` because they:

- start/stop docker containers (CI test-runner pool can't share docker state),
- mutate the shared dev `.env` if missing,
- can take 30-90s of build + startup time per run.

## upload-flow.sh - UC3/UC4/UC5/C1 Pflicht-Smoke (Plan 5)

Drives a real tus client (curl) against `tusproject/tusd:v2.4.0` and
verifies that:

| Concern | Assertion |
|---|---|
| **UC3** - tusd 2.x hook-body schema matches our handlers | `pre-create` returns 201 with `Location:` header |
| **UC4** - `fs.rename` is atomic O(1), no `EXDEV` | `/media/tusd-data/<id>.bin` disappears AND `/media/uploads/<userId>/<jobId>/source.bin` appears |
| **UC5** - Auth-forwarded via tusd | `Authorization: Bearer <api-key>` makes it through tusd -> api -> user lookup |
| **C1-Rev2** - Quota reservation under advisory-lock | `Job.status` transitions `uploading -> queued` (not failed, not stuck) |

### Prerequisites on host

- `docker` + `docker compose` (Compose v2)
- `openssl`, `curl`, `jq`, `node` (>= 18), `base64`

### Run

```bash
./apps/api/test-e2e/upload-flow.sh
```

Variables you can set:

| Var | Default | Meaning |
|---|---|---|
| `KEEP_STACK` | `0` | If `1`, leave the compose stack running after the script exits. Useful for `docker compose logs api` post-mortem. Otherwise `docker compose down -v` runs in a `trap`. |

### What it does

1. Tool-check (fail fast if any of the required binaries is missing).
2. Source `.env` (copy `.env.example` if missing) and assert all secrets are
   set.
3. `docker compose up -d --build api worker tusd` (also brings up `postgres`,
   `redis`, and runs `migrate` once via `depends_on`).
4. Wait for `GET /api/v1/health` and `OPTIONS /uploads/` on tusd.
5. Seed a test user + API-key directly via `psql` - equivalent to the HTTP
   `/auth/login` + `/users/me/api-keys` flow but without paying argon2 +
   CSRF cost. The HTTP auth path itself is covered by unit tests in
   `apps/api/src/auth/*.test.ts`.
6. POST `/uploads/` to tusd with `Upload-Length`, `Upload-Metadata`
   (filename/kind/profile), and `Authorization: Bearer ...`. Expect `201`.
7. PATCH the upload location with the PNG bytes. Expect `204`.
8. Poll `/media/uploads/<userId>/<jobId>/source.bin` (up to 10s) - assert
   the file moved.
9. Assert `/media/tusd-data/<jobId>.bin` is GONE (proves `rename` ran, not
   `copy + unlink`).
10. Query `Job.status` from postgres - must be `queued | running |
    succeeded` (not `uploading`, not `failed`).
11. Verify a BullMQ entry exists for the `jobId` in redis (best-effort -
    worker may have already consumed it).
12. `docker compose down -v` (unless `KEEP_STACK=1`).

### Failure post-mortem

The script prints `docker compose logs api --tail=80` on most failure paths.
For deeper debugging, re-run with `KEEP_STACK=1` and then:

```bash
docker compose logs api tusd worker
docker compose exec api ls -laR /media
docker compose exec postgres \
  psql -U mediacompressor -d mediacompressor -c \
  "SELECT id, status, kind, profile, \"reservedBytes\", \"errorCode\" FROM \"Job\" ORDER BY \"createdAt\" DESC LIMIT 5;"
```

### Why not in `vitest`?

The unit tests in `apps/api/src/uploads/*.test.ts` already exercise the
hook handlers via `app.inject()` against a mocked-but-real prisma + redis.
This smoke script's value-add is the **transport layer** - that
tusd-v2.4.0 actually sends the body shape we wrote a Zod schema for, that
the `media-data` volume is configured such that `rename` is atomic, that
the Authorization header survives the tusd hop. Those failure modes only
surface against a real binary, not in-process.

It runs on demand: before merging Plan 5, after upgrading the tusd image
tag in `docker-compose.yml`, or whenever the hook-body Zod schema is
touched.
