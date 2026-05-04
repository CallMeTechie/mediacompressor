-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'uploading', 'queued', 'processing', 'succeeded', 'failed', 'canceled', 'expired');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('image', 'video');

-- CreateEnum
CREATE TYPE "UsageEventType" AS ENUM ('job_submitted', 'bytes_in', 'bytes_out', 'job_failed');

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "uploadId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL,
    "kind" "JobKind" NOT NULL,
    "profile" TEXT NOT NULL,
    "overrides" JSONB NOT NULL,
    "inputFilename" TEXT NOT NULL,
    "reservedBytes" BIGINT NOT NULL DEFAULT 0,
    "inputBytes" BIGINT,
    "inputMime" TEXT,
    "inputStorageKey" TEXT,
    "outputBytes" BIGINT,
    "outputMime" TEXT,
    "outputFormat" TEXT,
    "outputStorageKey" TEXT,
    "metadata" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "progress" SMALLINT NOT NULL DEFAULT 0,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "jobId" UUID,
    "type" "UsageEventType" NOT NULL,
    "value" BIGINT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Job_uploadId_key" ON "Job"("uploadId");

-- CreateIndex
CREATE INDEX "Job_userId_status_idx" ON "Job"("userId", "status");

-- CreateIndex
CREATE INDEX "Job_status_expiresAt_idx" ON "Job"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "UsageEvent_userId_occurredAt_idx" ON "UsageEvent"("userId", "occurredAt" DESC);

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
