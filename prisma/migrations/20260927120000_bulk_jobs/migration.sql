-- Bulk jobs: phase-scoped progress, idempotent creation, auto-start, error codes,
-- result reuse and in-app notifications.

-- Job: idempotency key, auto-start and the phase snapshot.
ALTER TABLE "Job" ADD COLUMN "requestKey" TEXT;
ALTER TABLE "Job" ADD COLUMN "autoStart" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Job" ADD COLUMN "phaseTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "phaseFailedBase" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "phaseStartedAt" TIMESTAMP(3);

-- Jobs processing right now keep their progress bar: the phase is the whole job.
UPDATE "Job" SET "phaseTotal" = "total", "phaseStartedAt" = "startedAt" WHERE "status" = 'processing';

-- Jobs applying right now: the phase is what is still waiting to be written, counted from
-- now (images this round wrote before the deploy can't be told apart from earlier rounds'),
-- so the progress bar and the "N images were updated" notification count this round only,
-- not every image the job ever processed.
UPDATE "Job" j
SET "phaseTotal" = (
      SELECT COUNT(*) FROM "JobItem" i WHERE i."jobId" = j."id" AND i."status" IN ('approved', 'applying')
    ),
    "phaseFailedBase" = (
      SELECT COUNT(*) FROM "JobItem" i WHERE i."jobId" = j."id" AND i."status" = 'failed'
    ),
    "phaseStartedAt" = now(),
    "done" = 0,
    "failed" = 0
WHERE j."status" = 'applying';

-- Everything else falls back to lifetime counts while phaseTotal is 0.

-- Postgres allows any number of NULL keys, so jobs without a key are unaffected.
CREATE UNIQUE INDEX "Job_shopId_requestKey_key" ON "Job"("shopId", "requestKey");

-- JobItem: machine-readable failure reason, source hash, result reuse key, and the end of an
-- automatic retry's backoff (the item doesn't hold a shop slot until then).
ALTER TABLE "JobItem" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "JobItem" ADD COLUMN "sourceSha256" TEXT;
ALTER TABLE "JobItem" ADD COLUMN "resultKey" TEXT;
ALTER TABLE "JobItem" ADD COLUMN "retryAt" TIMESTAMP(3);

CREATE INDEX "JobItem_shopId_resultKey_idx" ON "JobItem"("shopId", "resultKey");

-- Notification: in-app notices (no personal data; removed with the shop or job).
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "url" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_shopId_readAt_createdAt_idx" ON "Notification"("shopId", "readAt", "createdAt");
CREATE INDEX "Notification_jobId_idx" ON "Notification"("jobId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
