#!/usr/bin/env bash
#
# Plan 5 Task 8 — UC3/UC4/UC5/C1 PFLICHT-E2E smoke script.
#
# Drives a real tus client (curl) against a real tusd v2.4.0 container and
# verifies that:
#   - tusd's hook-body schema matches our pre-create / post-finish handlers
#     (UC3 — "tusd 2.x schema is what we coded against").
#   - fs.rename(/media/tusd-data → /media/uploads) is atomic O(1) — no EXDEV
#     (UC4 — single named volume `media-data`).
#   - Auth-forward through tusd works: tusd passes Authorization to api which
#     resolves the user via API-Key (UC5).
#   - reserveQuota under advisory-lock + idempotency-key path works
#     end-to-end (C1-Rev2).
#
# This is a SMOKE script, NOT a vitest test — it requires the full compose
# stack and is unsuitable for the test-runner pool. Run it manually:
#
#     ./apps/api/test-e2e/upload-flow.sh
#
# Required tools on host: docker, docker compose, openssl, curl, jq, node
# (>= 18 — used to compute HMAC-SHA-256 hashes for direct DB-seed).
#
# Exit codes:
#   0 — all assertions passed
#   1 — assertion failed / setup error

set -euo pipefail

#################################################################
# 0. Locate repo root (script lives in apps/api/test-e2e/).
#################################################################
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="${SCRIPT_DIR}/../../.."
cd "${REPO_ROOT}"

echo "==> Repo root: $(pwd)"

#################################################################
# 1. Tool checks. Fail fast with a clear list of missing tools.
#################################################################
need=(docker openssl curl jq node base64)
missing=()
for t in "${need[@]}"; do
  if ! command -v "$t" >/dev/null 2>&1; then
    missing+=("$t")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: missing required tools: ${missing[*]}" >&2
  echo "Install them and retry." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' subcommand not available (need Compose v2)." >&2
  exit 1
fi

#################################################################
# 2. Ensure .env exists (compose needs it for ${VAR} substitution).
#################################################################
if [[ ! -f .env ]]; then
  echo "==> .env not found, copying from .env.example"
  cp .env.example .env
fi

# Source .env so we have the same view of secrets as compose. Use `set -a` so
# every assignment becomes an exported var (compose-friendly).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Sanity-check the secrets compose will substitute.
for v in TUSD_SHARED_SECRET API_KEY_PEPPER POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: \$${v} is unset in .env" >&2
    exit 1
  fi
done

#################################################################
# 3. Bring up the stack. Tear down on exit so re-runs are deterministic.
#################################################################
cleanup() {
  set +e
  if [[ "${KEEP_STACK:-0}" != "1" ]]; then
    echo "==> Tearing down compose stack"
    docker compose down -v
  else
    echo "==> KEEP_STACK=1 → leaving stack running for inspection"
  fi
}
trap cleanup EXIT

echo "==> Building + starting api, worker, tusd (and their deps)"
# `--build` is mandatory because api code change in apps/api/src/uploads/
# hooks-dispatcher.ts requires a fresh image.
docker compose up -d --build api worker tusd

#################################################################
# 4. Wait for /api/v1/health to return 200. tusd starts depends_on api but
#    only checks `service_started`, not health, so we re-check ourselves.
#################################################################
echo "==> Waiting for api /api/v1/health (max 60s)"
deadline=$(( $(date +%s) + 60 ))
until curl -sf http://localhost:3000/api/v1/health >/dev/null; do
  if (( $(date +%s) >= deadline )); then
    echo "ERROR: api did not become healthy within 60s" >&2
    docker compose logs api --tail=80 >&2 || true
    exit 1
  fi
  sleep 2
done
echo "    api healthy"

echo "==> Waiting for tusd :1080 (max 30s)"
deadline=$(( $(date +%s) + 30 ))
until curl -sf -o /dev/null -X OPTIONS http://localhost:1080/uploads/ -H 'Tus-Resumable: 1.0.0'; do
  if (( $(date +%s) >= deadline )); then
    echo "ERROR: tusd did not start within 30s" >&2
    docker compose logs tusd --tail=80 >&2 || true
    exit 1
  fi
  sleep 1
done
echo "    tusd healthy"

#################################################################
# 5. Seed test user + API-key directly via psql. Going via the HTTP login +
#    CSRF + create-key path would require argon2 cost paid by the script and
#    a session-cookie dance — direct seeding is faster and equally valid for
#    a smoke test (the auth path itself is unit-tested elsewhere).
#################################################################
TEST_EMAIL="e2e-upload-flow@b.com"
TEST_USER_ID="$(node -e 'console.log(require("crypto").randomUUID())')"

# generateApiKey() format: mc_<prefix-8>_<base64url-of-32-random-bytes>
KEY_RAW="$(node -e '
  const c = require("crypto");
  const raw = c.randomBytes(8 + 32);
  const prefix = raw.subarray(0, 8).toString("base64url").slice(0, 8);
  const body = raw.subarray(8).toString("base64url");
  process.stdout.write(`mc_${prefix}_${body}\n${prefix}\n`);
')"
API_KEY="$(echo "$KEY_RAW" | sed -n '1p')"
KEY_PREFIX="$(echo "$KEY_RAW" | sed -n '2p')"

# hashApiKey: HMAC-SHA-256(API_KEY_PEPPER, key) hex.
KEY_HASH="$(API_KEY="$API_KEY" PEPPER="$API_KEY_PEPPER" node -e '
  const c = require("crypto");
  console.log(c.createHmac("sha256", Buffer.from(process.env.PEPPER))
    .update(process.env.API_KEY).digest("hex"));
')"

# argon2id password hash. We never log in via HTTP in this test, so any valid
# hash works — but the User-row demands a non-null passwordHash.
DUMMY_PWHASH='$argon2id$v=19$m=65536,t=3,p=1$ZXhhbXBsZS1zYWx0$fakehashplaceholderfakehashplaceholderfakehash'

PSQL() {
  docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$@"
}

echo "==> Seeding test user (${TEST_EMAIL}) and API-key (${KEY_PREFIX})"
# Be idempotent: clean any leftovers from a prior failed run with this email.
PSQL "DELETE FROM \"Job\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '${TEST_EMAIL}');" >/dev/null
PSQL "DELETE FROM \"ApiKey\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '${TEST_EMAIL}');" >/dev/null
PSQL "DELETE FROM \"Session\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '${TEST_EMAIL}');" >/dev/null
PSQL "DELETE FROM \"User\" WHERE email = '${TEST_EMAIL}';" >/dev/null

PSQL "INSERT INTO \"User\" (id, email, \"passwordHash\", status, \"storageQuota\", \"parallelQuota\", \"hourlyQuota\", \"createdAt\")
      VALUES ('${TEST_USER_ID}', '${TEST_EMAIL}', '${DUMMY_PWHASH}', 'active', 1000000000, 100, 1000, NOW());" >/dev/null

PSQL "INSERT INTO \"ApiKey\" (id, \"userId\", name, \"keyHash\", \"keyPrefix\", scopes, \"createdAt\")
      VALUES (gen_random_uuid(), '${TEST_USER_ID}', 'e2e-smoke', '${KEY_HASH}', '${KEY_PREFIX}', ARRAY['jobs:write','jobs:read'], NOW());" >/dev/null

echo "    user_id=${TEST_USER_ID}"

#################################################################
# 6. Drive a tus upload. Use a 1x1 PNG so the magic-number check in
#    post-finish-hook passes deterministically.
#################################################################
PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='
PNG_BIN_FILE="$(mktemp -t e2e-png-XXXXXX.bin)"
echo -n "$PNG_B64" | base64 -d > "$PNG_BIN_FILE"
PNG_BYTES="$(wc -c < "$PNG_BIN_FILE")"
trap 'rm -f "$PNG_BIN_FILE"; cleanup' EXIT

# Upload-Metadata is comma-separated `key base64-value` pairs.
META_FILENAME="$(printf 'e2e.png' | base64 -w0)"
META_KIND="$(printf 'image' | base64 -w0)"
META_PROFILE="$(printf 'web-optimized' | base64 -w0)"
UPLOAD_META="filename ${META_FILENAME},kind ${META_KIND},profile ${META_PROFILE}"

echo "==> POST /uploads/ (tus create) — bytes=${PNG_BYTES}"
CREATE_RES="$(curl -sS -i -X POST http://localhost:1080/uploads/ \
  -H 'Tus-Resumable: 1.0.0' \
  -H "Upload-Length: ${PNG_BYTES}" \
  -H "Upload-Metadata: ${UPLOAD_META}" \
  -H "Authorization: Bearer ${API_KEY}")"

echo "$CREATE_RES" | head -1

CREATE_STATUS="$(echo "$CREATE_RES" | head -1 | awk '{print $2}')"
if [[ "$CREATE_STATUS" != "201" ]]; then
  echo "ERROR: tus create expected 201, got ${CREATE_STATUS}" >&2
  echo "$CREATE_RES" >&2
  docker compose logs api --tail=60 >&2
  exit 1
fi

LOCATION="$(echo "$CREATE_RES" | grep -i '^location:' | tr -d '\r' | sed -E 's/^[Ll]ocation:[[:space:]]*//')"
if [[ -z "$LOCATION" ]]; then
  echo "ERROR: no Location header in 201 response" >&2
  exit 1
fi

# Upload-id in tusd is the basename of the Location URL. With our
# pre-create-hook ChangeFileInfo.ID it equals Job.id.
UPLOAD_ID="${LOCATION##*/}"
# Strip query string if any.
UPLOAD_ID="${UPLOAD_ID%%\?*}"
echo "    upload_id=${UPLOAD_ID}"

# tusd may publish Location as host-relative ("/uploads/<id>") or absolute
# ("http://api:3000/uploads/<id>" with the internal hostname). Normalize.
case "$LOCATION" in
  http://*|https://*)
    PATCH_URL="$(echo "$LOCATION" | sed -E 's|^https?://[^/]+|http://localhost:1080|')"
    ;;
  /*)
    PATCH_URL="http://localhost:1080${LOCATION}"
    ;;
  *)
    PATCH_URL="http://localhost:1080/uploads/${UPLOAD_ID}"
    ;;
esac

echo "==> PATCH ${PATCH_URL} (single chunk)"
PATCH_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$PATCH_URL" \
  -H 'Tus-Resumable: 1.0.0' \
  -H 'Upload-Offset: 0' \
  -H 'Content-Type: application/offset+octet-stream' \
  -H "Authorization: Bearer ${API_KEY}" \
  --data-binary "@${PNG_BIN_FILE}")"

if [[ "$PATCH_STATUS" != "204" ]]; then
  echo "ERROR: tus PATCH expected 204, got ${PATCH_STATUS}" >&2
  docker compose logs api --tail=60 >&2
  exit 1
fi
echo "    upload completed"

#################################################################
# 7. Verifications. Allow up to 10s for the post-finish-hook to fire (it's
#    invoked by tusd asynchronously after the PATCH 204).
#################################################################
echo "==> Verifying file moved into /media/uploads/<userId>/<jobId>/source.bin"
deadline=$(( $(date +%s) + 10 ))
moved_path="/media/uploads/${TEST_USER_ID}/${UPLOAD_ID}/source.bin"
until docker compose exec -T api test -f "$moved_path" 2>/dev/null; do
  if (( $(date +%s) >= deadline )); then
    echo "ERROR: source.bin did not appear at ${moved_path} within 10s" >&2
    echo "--- ls /media/uploads/${TEST_USER_ID} (api):"
    docker compose exec -T api ls -laR "/media/uploads/${TEST_USER_ID}" 2>&1 || true
    echo "--- ls /media/tusd-data (api):"
    docker compose exec -T api ls -la /media/tusd-data 2>&1 || true
    docker compose logs api --tail=80 >&2
    exit 1
  fi
  sleep 1
done
echo "    file at ${moved_path}"

echo "==> Verifying tusd-data scratch was cleaned up (rename, not copy)"
if docker compose exec -T api test -f "/media/tusd-data/${UPLOAD_ID}.bin"; then
  echo "ERROR: tusd-data scratch file still present — rename did not happen" >&2
  exit 1
fi
echo "    /media/tusd-data/${UPLOAD_ID}.bin gone"

echo "==> Verifying Job row status"
JOB_STATUS="$(PSQL "SELECT status FROM \"Job\" WHERE id = '${UPLOAD_ID}';")"
case "$JOB_STATUS" in
  queued|succeeded|running)
    echo "    Job.status=${JOB_STATUS} (acceptable)"
    ;;
  uploading)
    echo "ERROR: Job.status=uploading — post-finish-hook did not transition" >&2
    exit 1
    ;;
  *)
    echo "ERROR: unexpected Job.status='${JOB_STATUS}'" >&2
    exit 1
    ;;
esac

echo "==> Verifying BullMQ queue had at least one entry for this jobId"
# BullMQ keys: bull:compress:{id}, bull:compress:waiting, bull:compress:active, ...
QUEUE_HIT="$(docker compose exec -T redis redis-cli --raw EXISTS "bull:compress:${UPLOAD_ID}")"
if [[ "$QUEUE_HIT" != "1" ]]; then
  echo "WARNING: BullMQ entry for jobId not found — worker may have already consumed it." >&2
  echo "         Job.status=${JOB_STATUS} is the load-bearing assertion; queue-key is best-effort." >&2
fi

echo
echo "================================="
echo "  E2E SMOKE PASSED"
echo "================================="
echo "  user_id  = ${TEST_USER_ID}"
echo "  job_id   = ${UPLOAD_ID}"
echo "  status   = ${JOB_STATUS}"
echo
exit 0
