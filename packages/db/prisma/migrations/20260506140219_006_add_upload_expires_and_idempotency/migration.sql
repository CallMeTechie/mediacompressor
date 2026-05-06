-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "precreateIdempotencyKey" TEXT,
ADD COLUMN     "uploadExpiresAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "Job_precreateIdempotencyKey_key" ON "Job"("precreateIdempotencyKey");
