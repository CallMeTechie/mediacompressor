#!/usr/bin/env bash
# Plan 9 Task 4: Production-stack smoke-test.
# Run AFTER `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
# completes its boot-sequence. Validates:
#   1. Caddy responds on 80 (HTTP->HTTPS redirect).
#   2. API health-endpoint via Caddy HTTPS.
#   3. Plan-8d/8e/8f locale files present in api-container (en + de loop per WC-prod-13).
#   4. Plan-8f client-bridge JS present in api-container.
#   5. tusd reachable via Caddy /uploads/ (OPTIONS handshake).
#   6. (production only) cert-CN matches DOMAIN + LE-issuer (WC-prod-9).
#
# Exits 0 on success, non-zero on first failure.
#
# Usage: ./scripts/smoke-test-prod.sh [DOMAIN]    (default localhost)

set -euo pipefail

DOMAIN="${1:-localhost}"

if [ "$DOMAIN" = "localhost" ]; then
  CURL_BASE="-sf"
  INSECURE_FLAG="--insecure"   # Caddyfile.dev uses internal CA
  HTTPS_URL="https://localhost"
else
  CURL_BASE="-sf"
  INSECURE_FLAG=""              # production: validate real Let's Encrypt cert
  HTTPS_URL="https://${DOMAIN}"
fi

echo "=== smoke-test-prod (DOMAIN=${DOMAIN}) ==="

echo ""
echo "Step 1: HTTP response on port 80"
status=$(curl -s -o /dev/null -w '%{http_code}' "http://${DOMAIN}/api/v1/health" || true)
case "$status" in
  301|302|308) echo "  ✓ HTTP returns redirect ($status)" ;;
  200) echo "  ✓ HTTP returns 200 (Caddyfile.dev disable_redirects path)" ;;
  *) echo "  ✗ HTTP returned unexpected status: $status" >&2; exit 1 ;;
esac

echo ""
echo "Step 2: API health-endpoint via Caddy HTTPS"
curl $CURL_BASE $INSECURE_FLAG "${HTTPS_URL}/api/v1/health" > /tmp/health-response.json
grep -q '"status":"ok"' /tmp/health-response.json \
  || (echo "  ✗ health response missing status:ok" >&2; cat /tmp/health-response.json; exit 1)
echo "  ✓ /api/v1/health returns status:ok"

echo ""
echo "Step 3: Plan-8d/8e/8f locale files present in api-container (en + de)"
expected=$'admin.json\nauth.json\ncommon.json\ndashboard.json\njobs.json\nprofile.json'
for lng in de en; do
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api ls -1 apps/api/locales/${lng}/ \
    | grep -E '^(common|auth|dashboard|jobs|profile|admin)\.json$' \
    | sort > /tmp/${lng}-locales.txt
  if [ "$(cat /tmp/${lng}-locales.txt)" != "$expected" ]; then
    echo "  ✗ ${lng} locale mismatch:" >&2
    diff <(echo "$expected") /tmp/${lng}-locales.txt
    exit 1
  fi
  echo "  ✓ ${lng}: all 6 namespaces present"
done

echo ""
echo "Step 4: Plan-8f client-bridge present"
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api test -f apps/api/public/js/i18n-bridge.js \
  || (echo "  ✗ apps/api/public/js/i18n-bridge.js missing in container" >&2; exit 1)
echo "  ✓ i18n-bridge.js present"

echo ""
echo "Step 5: /uploads/ proxied to tusd via Caddy (OPTIONS handshake)"
status=$(curl -s -o /dev/null -w '%{http_code}' \
  $INSECURE_FLAG \
  -X OPTIONS \
  -H "Tus-Resumable: 1.0.0" \
  "${HTTPS_URL}/uploads/" || true)
if [ "$status" != "204" ] && [ "$status" != "200" ]; then
  echo "  ✗ /uploads/ returned $status (expected 204 from tusd OPTIONS)" >&2
  exit 1
fi
echo "  ✓ /uploads/ proxy reachable (tusd OPTIONS = $status)"

# Step 6: production-only TLS cert validation (WC-prod-9 + Rev. 2.1)
if [ "$DOMAIN" != "localhost" ]; then
  echo ""
  echo "Step 6: TLS cert-CN + LE-issuer validation"
  cert_info=$(echo | openssl s_client -servername "${DOMAIN}" -connect "${DOMAIN}:443" 2>/dev/null \
    | openssl x509 -noout -subject -issuer)
  echo "$cert_info" | grep -q "CN ?= ${DOMAIN}" \
    || (echo "  ✗ cert-CN doesn't match ${DOMAIN}" >&2; echo "$cert_info" >&2; exit 1)
  echo "$cert_info" | grep -qE "Let's Encrypt|R3|R10|R11|E1|E5|E6|E7" \
    || (echo "  ✗ cert issuer is not Let's Encrypt" >&2; echo "$cert_info" >&2; exit 1)
  echo "  ✓ cert valid for ${DOMAIN} from Let's Encrypt"
fi

echo ""
echo "=== ALL SMOKE-TESTS PASSED ==="
