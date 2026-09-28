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
import { retryStronger } from "../lib/jobs.server";

const RetryStrongerSchema = z
  .object({
    /** Images to process again with the paid model first (JobItem ids). Required. */
    itemIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_SELECTION_IDS),
  })
  .strict();

export const loader = () => apiMethodNotAllowed("POST");

/**
 * POST /api/image-jobs/:jobId/retry-stronger {itemIds}: "Retry with stronger model". Images in
 * review whose result is ready, needs review (flagged) or already clean (unchanged) are
 * processed again with the image service's paid backend first (settings.force_escalation);
 * the job goes back to processing for them. Nothing is charged (credits are charged only when
 * an image is applied); the images are reserved again at their quoted price (402 {needed,
 * available} when credits are short). Other images are ignored, so a repeat answers retried 0.
 * 409 when the job isn't in review. Answers {retried, skipped, status, phase}; skipped images
 * are in another unfinished job.
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    if (request.method !== "POST") return apiMethodNotAllowed("POST");
    const { shop } = await requireApiShop(request);
    const jobId = params.jobId ?? "";
    const { itemIds } = RetryStrongerSchema.parse(await readJsonBody(request));
    const result = await retryStronger(shop.id, jobId, [...new Set(itemIds)]);
    const job = await getApiJob(shop.id, jobId);
    if (!job) throw jobNotFound();
    return apiJson({ retried: result.retried, skipped: result.skipped, status: job.status, phase: job.phase });
  } catch (error) {
    return apiError(error);
  }
};
