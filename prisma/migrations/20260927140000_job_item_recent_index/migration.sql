-- The last changed images of a job (GET /api/image-jobs/:jobId/items?sort=recent, which the
-- job page's cleaning strip polls every few seconds while a job processes): read backwards
-- from this index, a handful of rows whatever the job's size, instead of every finished row
-- of the job fetched and sorted.
-- CreateIndex
CREATE INDEX "JobItem_jobId_updatedAt_idx" ON "JobItem"("jobId", "updatedAt");
