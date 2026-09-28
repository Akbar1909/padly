import type { LoaderFunctionArgs } from "react-router";
import { apiError, apiJson, apiMethodNotAllowed, getApiJob, jobNotFound, requireApiShop } from "../lib/api.server";

export const action = () => apiMethodNotAllowed("GET");

/**
 * GET /api/image-jobs/:jobId: the job with live progress, in the spec vocabulary (status) and
 * the internal one (phase). "completed" means processed and ready for review, never written
 * to Shopify; needsAction says what the merchant must do next. 404 for another shop's job.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { shop } = await requireApiShop(request);
    const job = await getApiJob(shop.id, params.jobId ?? "");
    if (!job) throw jobNotFound();
    return apiJson(job);
  } catch (error) {
    return apiError(error);
  }
};
