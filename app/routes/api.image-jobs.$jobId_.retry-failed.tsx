import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import {
  apiError,
  apiJson,
  apiMethodNotAllowed,
  getApiJob,
  jobNotFound,
  readJsonBody,
  requireApiShop,
} from "../lib/api.server";
import { MAX_SELECTION_IDS } from "../lib/filters";
import { retryFailed } from "../lib/jobs.server";

const RetryRequestSchema = z
  .object({
    /** Failed images to retry (JobItem ids); all failed images of the job when omitted. */
    itemIds: z.array(z.string().min(1).max(100)).max(MAX_SELECTION_IDS).optional(),
  })
  .strict();

export const loader = () => apiMethodNotAllowed("POST");

/**
 * POST /api/image-jobs/:jobId/retry-failed {itemIds?}: send failed images back (processing
 * failures are processed again, apply failures go back to approved). Only failed images are
 * touched; nothing matching answers retried 0, so a repeat is harmless. Allowed in review or
 * done (409 otherwise), 402 {needed, available} when credits are short.
 * Answers {retried, skipped, status, phase}; skipped images are in another unfinished job.
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    if (request.method !== "POST") return apiMethodNotAllowed("POST");
    const { shop } = await requireApiShop(request);
    const jobId = params.jobId ?? "";
    const { itemIds } = RetryRequestSchema.parse(await readJsonBody(request));
    const result = await retryFailed(shop.id, jobId, itemIds ? [...new Set(itemIds)] : undefined);
    const job = await getApiJob(shop.id, jobId);
    if (!job) throw jobNotFound();
    return apiJson({ retried: result.retried, skipped: result.skipped, status: job.status, phase: job.phase });
  } catch (error) {
    return apiError(error);
  }
};
