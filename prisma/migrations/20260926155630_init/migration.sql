-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('reading', 'estimated', 'processing', 'review', 'applying', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "JobItemStatus" AS ENUM ('queued', 'processing', 'ready', 'flagged', 'approved', 'rejected', 'applying', 'applied', 'failed', 'restore_queued', 'restoring', 'restored');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "freeCreditsGranted" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Preset" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "aspect" TEXT NOT NULL DEFAULT '1:1',
    "marginPct" INTEGER NOT NULL DEFAULT 8,
    "removeBg" BOOLEAN NOT NULL DEFAULT true,
    "bgColor" TEXT NOT NULL DEFAULT '#FFFFFF',
    "upscale" BOOLEAN NOT NULL DEFAULT false,
    "upscaleThresholdPx" INTEGER NOT NULL DEFAULT 1200,
    "targetPx" INTEGER NOT NULL DEFAULT 2048,
    "aiMetadata" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "presetSnapshot" JSONB NOT NULL,
    "filter" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'reading',
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "estimatedCredits" INTEGER NOT NULL DEFAULT 0,
    "bulkOperationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "mediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "alt" TEXT,
    "originalUrl" TEXT NOT NULL,
    "mimeType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "fileSize" INTEGER,
    "status" "JobItemStatus" NOT NULL DEFAULT 'queued',
    "upscaleEligible" BOOLEAN NOT NULL DEFAULT false,
    "upscaleApplied" BOOLEAN NOT NULL DEFAULT false,
    "backupKey" TEXT,
    "outputKey" TEXT,
    "previewKey" TEXT,
    "beforeKey" TEXT,
    "maskKey" TEXT,
    "outputFormat" TEXT,
    "outputWidth" INTEGER,
    "outputHeight" INTEGER,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "metrics" JSONB,
    "fidelity" DOUBLE PRECISION,
    "models" JSONB,
    "creditsReserved" INTEGER NOT NULL DEFAULT 0,
    "creditsCharged" INTEGER NOT NULL DEFAULT 0,
    "appliedMediaId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "jobItemId" TEXT,
    "purchaseId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyChargeId" TEXT,
    "pack" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "test" BOOLEAN NOT NULL DEFAULT false,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Preset_shopId_idx" ON "Preset"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_bulkOperationId_key" ON "Job"("bulkOperationId");

-- CreateIndex
CREATE INDEX "Job_shopId_createdAt_idx" ON "Job"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_updatedAt_idx" ON "Job"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "JobItem_jobId_status_idx" ON "JobItem"("jobId", "status");

-- CreateIndex
CREATE INDEX "JobItem_mediaId_idx" ON "JobItem"("mediaId");

-- CreateIndex
CREATE INDEX "JobItem_shopId_status_idx" ON "JobItem"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobItem_jobId_mediaId_key" ON "JobItem"("jobId", "mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_shopId_createdAt_idx" ON "CreditLedger"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_shopifyChargeId_key" ON "Purchase"("shopifyChargeId");

-- CreateIndex
CREATE INDEX "Purchase_shopId_createdAt_idx" ON "Purchase"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "Preset" ADD CONSTRAINT "Preset_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
