-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(32) NOT NULL,
    "targetId" UUID NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_createdAt_idx" ON "AuditEvent"("targetType", "targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plan 10 Task 1 Rev. 2.1 WC-audit-14 / WC-audit-19: AuditEvent integrity is
-- application-enforced — `@mediacompressor/audit` exports NO mutation-API
-- beyond recordAuditEvent. PostgreSQL RLS-policies deferred to Plan 11+ when
-- multi-role deploy + secrets-block migration lands. Direct DB-access
-- (psql, prisma:studio) can still mutate AuditEvent rows; trust-model
-- assumes operator-authorized DB-access only.

-- Plan 10 Task 1 Rev. 2.1 WC-audit-15: GDPR-anonymization sentinel-user.
-- Used by docs/operations/runbook.md DSGVO-procedure to redirect FK on
-- audit-events when the original actor's User-row must be erased.
-- Idempotent: ON CONFLICT DO NOTHING — safe for repeated migration-runs.
-- The User schema has NO `updatedAt` column (verified against schema.prisma);
-- only `createdAt` is set.
--
-- The passwordHash is intentionally non-verifying:
--   1. Malformed salt: 30 'x' chars is not a base64 byte-aligned length, so
--      argon2.verify rejects with parse-error (caught by auth-package, returns false).
--   2. Defense-in-depth: status='disabled' rejects login regardless of hash-verify.
-- Both paths must change for this account to ever authenticate.
INSERT INTO "User" (
  id,
  email,
  "passwordHash",
  role,
  status,
  "storageQuota",
  "parallelQuota",
  "hourlyQuota",
  "createdAt"
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  'anonymized@deleted.invalid',
  '$argon2id$v=19$m=4096,t=2,p=1$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'user'::"UserRole",
  'disabled'::"UserStatus",
  0,
  0,
  0,
  NOW()
) ON CONFLICT (id) DO NOTHING;
