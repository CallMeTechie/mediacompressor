-- CreateTable
CREATE TABLE "PepperCanary" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "expectedHmac" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PepperCanary_pkey" PRIMARY KEY ("id")
);
