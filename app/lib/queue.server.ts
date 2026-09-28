import { Queue } from "bullmq";
import { env } from "./env.server";
import { createRedis, redis, withTimeout } from "./redis.server";

export const ITEMS_QUEUE = "vio-items";
export const JOBS_QUEUE = "vio-jobs";

/** Per-image work. The DB status was already claimed by pumpShop before enqueueing. */
export interface ItemTask {
  kind: "process" | "apply" | "restore";
  itemId: string;
  jobId: string;
  shopId: string;
}

/** Job-level and housekeeping work. */
export type JobTask =
  | { name: "read"; jobId: string }
  | { name: "ingest-bulk"; jobId: string; url: string | null }
  | { name: "maintenance" }
  | { name: "purge-shop"; shopId: string }
  // Ask Shopify whether the app is still installed (see verifyInstalled in worker/tasks/jobs.ts).
  | { name: "verify-uninstalled"; shopId: string; reason: "redact" | "inactive" }
  // Email one notification (only enqueued when an email provider is configured).
  | { name: "notify-email"; notificationId: string };

declare global {
  // eslint-disable-next-line no-var
  var vioQueues: { items: Queue<ItemTask>; jobs: Queue<JobTask> } | undefined;
}

/** How long a producer waits on Redis before giving up (the caller logs and moves on). */
export const ENQUEUE_TIMEOUT_MS = 5_000;

function queues() {
  if (!global.vioQueues) {
    // Producers fail fast while Redis is down (no offline queue): the DB row is the source of
    // truth, and maintenance re-enqueues whatever didn't make it onto the queue.
    const connection = createRedis({ enableOfflineQueue: false });
    const e = env();
    global.vioQueues = {
      items: new Queue<ItemTask>(ITEMS_QUEUE, {
        connection,
        defaultJobOptions: {
          attempts: e.ITEM_TASK_ATTEMPTS,
          backoff: { type: "exponential", delay: e.ITEM_RETRY_BASE_MS },
          removeOnComplete: { age: 24 * 3600, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      }),
      jobs: new Queue<JobTask>(JOBS_QUEUE, {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: { age: 24 * 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      }),
    };
  }
  return global.vioQueues;
}

export const itemsQueue = () => queues().items;
export const jobsQueue = () => queues().jobs;

/** Deterministic id so the reconciler can look the BullMQ job up from the DB row. */
export const itemTaskId = (kind: ItemTask["kind"], itemId: string, attempt: number) =>
  `${kind}-${itemId}-${attempt}`;

/** One purge attempt per shop per hour; a failed task keeps its id for 7 days, so the id must change to retry. */
export const purgeTaskId = (shopId: string) => `purge-${shopId}-${Math.floor(Date.now() / 3_600_000)}`;

/** Same scheme for install checks: at most one per shop per hour. */
export const verifyTaskId = (shopId: string) => `verify-${shopId}-${Math.floor(Date.now() / 3_600_000)}`;

export async function enqueueJobTask(task: JobTask, opts: { jobId?: string; delay?: number } = {}) {
  await withTimeout(jobsQueue().add(task.name, task, opts), ENQUEUE_TIMEOUT_MS, "enqueue");
}

// ─── Image-service circuit breaker ──────────────────────────────────────────

/**
 * Set by the worker when the image service is unreachable or overloaded. While it exists,
 * pumpShop claims no new images to process (applies and restores continue), so an outage
 * doesn't burn every queued image's retries. It expires on its own; maintenance's
 * per-minute nudge then resumes claiming.
 */
export const GPU_DOWN_KEY = "gpu:down";

export async function markGpuDown(seconds = 60): Promise<void> {
  await withTimeout(redis().set(GPU_DOWN_KEY, "1", "EX", seconds), 2_000, "gpu:down set");
}

/** False when the breaker is closed, or when Redis can't answer quickly (never block the pump). */
export async function isGpuDown(): Promise<boolean> {
  try {
    return (await withTimeout(redis().exists(GPU_DOWN_KEY), 1_000, "gpu:down check")) === 1;
  } catch {
    return false;
  }
}
