-- Quality states: the image service's final status per image and "Retry with stronger model".

-- NO_CHANGE: the photo already met the preset. Never applied or charged, and not reserved
-- (not in RESERVING_ITEM_STATUSES). PostgreSQL 12+ allows ADD VALUE inside the migration's
-- transaction; the value isn't used in this migration.
ALTER TYPE "JobItemStatus" ADD VALUE IF NOT EXISTS 'unchanged';

-- "Retry with stronger model": the worker sends settings.force_escalation for these items.
ALTER TABLE "JobItem" ADD COLUMN "forceEscalation" BOOLEAN NOT NULL DEFAULT false;
