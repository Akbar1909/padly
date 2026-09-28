/**
 * Background worker: `npm run worker` (prod) / `npm run worker:dev`.
 * Runs item tasks (process / apply / restore) and job tasks (read, bulk
 * ingest, maintenance, install checks, purge). Scale by running more containers.
 */
import "./bootstrap-env";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import prisma from "../app/db.server";
import { env } from "../app/lib/env.server";
import { errorMessage, isRetryable } from "../app/lib/errors";
import { GpuServiceError } from "../app/lib/gpu.server";
import { failJob, itemRetryScheduled } from "../app/lib/jobs.server";
import {
  ITEMS_QUEUE,
  JOBS_QUEUE,
  jobsQueue,
  markGpuDown,
  type ItemTask,
  type JobTask,
} from "../app/lib/queue.server";
import { createRedis } from "../app/lib/redis.server";
import { log } from "./log";
import { itemFailureCode, readFailureMessage } from "./messages";
import { backoffBaseMs, GPU_CODE_MAX_ATTEMPTS, isFinalAttempt, retryDelayMs } from "./retries";
import { afterItemTask, markItemFailed, runItemTask } from "./tasks/items";
import { ingestBulk, maintenance, purgeShop, readJob, verifyInstalled } from "./tasks/jobs";
import { sendNotificationEmail } from "./tasks/notify";

const e = env();

/**
 * How long an item task's lock lives without renewal. BullMQ renews it every half of this; a
 * Redis blip longer than the lock makes the stalled checker run the task a second time while
 * the first run continues (two image-service calls, two Shopify writes), so it is well above
 * BullMQ's 30 s default. A crashed worker's tasks are picked up again after about this long.
 */
const ITEM_LOCK_MS = 120_000;

const itemsWorker = new Worker<ItemTask>(
  ITEMS_QUEUE,
  async (job: Job<ItemTask>) => {
    const task = job.data;
    const attempt = job.attemptsMade + 1;
    try {
      await runItemTask(task, { attempt });
    } catch (error) {
      const retryable = isRetryable(error);
      // Timeouts and out-of-memory get fewer tries than ITEM_TASK_ATTEMPTS (worker/retries.ts).
      const final = isFinalAttempt(error, attempt, job.opts.attempts ?? 1);
      log.warn("item task failed", {
        kind: task.kind,
        itemId: task.itemId,
        attempt,
        retryable,
        error: errorMessage(error),
      });
      log.warn("IMAGE_JOB_FAILED", {
        itemId: task.itemId,
        jobId: task.jobId,
        shopId: task.shopId,
        kind: task.kind,
        attempt,
        retryable,
        final,
        reason: itemFailureCode(error),
        error: errorMessage(error),
      });
      if (error instanceof GpuServiceError && error.serviceDown) {
        // Stop claiming new images for a minute instead of burning every queued image's retries.
        await markGpuDown().catch((err) => log.warn("gpu:down not set", { error: errorMessage(err) }));
      }
      if (!final) {
        // BullMQ retries with backoff. Meanwhile the image gives its shop slot back, so the
        // shop's restores, applies and other images don't wait out the backoff.
        const delayMs = retryDelayMs(attempt, backoffBaseMs(job.opts.backoff, e.ITEM_RETRY_BASE_MS));
        await itemRetryScheduled(task, delayMs).catch((err) =>
          log.warn("retry backoff not recorded", { itemId: task.itemId, error: errorMessage(err) }),
        );
        throw error;
      }
      await markItemFailed(task, error);
    }
    await afterItemTask(task);
  },
  { connection: createRedis(), concurrency: e.WORKER_CONCURRENCY, lockDuration: ITEM_LOCK_MS },
);

const jobsWorker = new Worker<JobTask>(
  JOBS_QUEUE,
  async (job: Job<JobTask>) => {
    const task = job.data;
    try {
      switch (task.name) {
        case "read":
          return await readJob(task.jobId);
        case "ingest-bulk":
          return await ingestBulk(task.jobId);
        case "maintenance":
          return await maintenance();
        case "purge-shop":
          return await purgeShop(task.shopId);
        case "verify-uninstalled":
          return await verifyInstalled(task.shopId, task.reason);
        case "notify-email":
          return await sendNotificationEmail(task.notificationId);
      }
    } catch (error) {
      const retryable = isRetryable(error);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      log.warn("job task failed", { task: task.name, attempt: job.attemptsMade + 1, error: errorMessage(error) });
      if ((!retryable || lastAttempt) && (task.name === "read" || task.name === "ingest-bulk")) {
        // The merchant sees plain words; the detail is in the log line above.
        await failJob(task.jobId, readFailureMessage(error));
        return;
      }
      if ((task.name === "purge-shop" || task.name === "verify-uninstalled") && (!retryable || lastAttempt)) {
        // Maintenance re-enqueues it next hour, but someone should know.
        log.error(`${task.name} failed`, { shopId: task.shopId, error: errorMessage(error) });
      }
      if (!retryable) throw new UnrecoverableError(errorMessage(error));
      throw error;
    }
  },
  { connection: createRedis(), concurrency: 4 },
);

for (const [queue, w] of [
  [ITEMS_QUEUE, itemsWorker],
  [JOBS_QUEUE, jobsWorker],
] as const) {
  w.on("error", (error) => log.error("worker error", { queue, error: errorMessage(error) }));
  // A task whose lock expired (worker crash, event loop blocked, Redis outage) goes back to
  // waiting once; a second stall fails it, and maintenance then fails its image for good.
  w.on("stalled", (taskId) => log.warn("task stalled", { queue, taskId }));
}

await jobsQueue().upsertJobScheduler(
  "maintenance",
  { every: 60_000 },
  { name: "maintenance", data: { name: "maintenance" }, opts: { attempts: 1 } },
);

log.info("worker started", {
  concurrency: e.WORKER_CONCURRENCY,
  shopConcurrency: e.SHOP_CONCURRENCY,
  itemAttempts: e.ITEM_TASK_ATTEMPTS,
  itemRetryBaseMs: e.ITEM_RETRY_BASE_MS,
  gpuCodeMaxAttempts: GPU_CODE_MAX_ATTEMPTS,
  itemLockMs: ITEM_LOCK_MS,
});

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  await Promise.allSettled([itemsWorker.close(), jobsWorker.close()]);
  await jobsQueue().close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
