-- How each image was made (methods, Replicate calls, estimated cost, quality), for monitoring.
ALTER TABLE "JobItem" ADD COLUMN "processing" JSONB;
