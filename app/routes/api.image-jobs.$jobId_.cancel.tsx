import type { ActionFunctionArgs } from "react-router";
import { apiError, apiJson, apiMethodNotAllowed, getApiJob, jobNotFound, requireApiShop } from "../lib/api.server";
import { cancelJob } from "../lib/jobs.server";

export const loader = () => apiMethodNotAllowed("POST");

/**
 * POST /api/image-jobs/:jobId/cancel. A queued or processing job is cancelled: queued images
 * are never picked up, and images already at the image service finish. An applying job stops
 * and goes back to review (writes under way finish and are charged; the rest stay approved),
 * so its status becomes completed or completed_with_errors. A job in review, done, failed or
 * cancelled answers 409. Answers {status, phase}.
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    if (request.method !== "POST") return apiMethodNotAllowed("POST");
    const { shop } = await requireApiShop(request);
    const jobId = params.jobId ?? "";
    await cancelJob(shop.id, jobId);
    const job = await getApiJob(shop.id, jobId);
    if (!job) throw jobNotFound();
    return apiJson({ status: job.status, phase: job.phase });
  } catch (error) {
    return apiError(error);
  }
};
