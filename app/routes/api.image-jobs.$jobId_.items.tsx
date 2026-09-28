import type { LoaderFunctionArgs } from "react-router";
import { apiError, apiJson, apiMethodNotAllowed, jobNotFound, listApiItems, requireApiShop } from "../lib/api.server";

export const action = () => apiMethodNotAllowed("GET");

/**
 * GET /api/image-jobs/:jobId/items?status=&sort=&include=&page=&limit=: one page of the job's
 * images. status is a spec status (queued, processing, completed, failed) or an internal one
 * (ready, approved, applied…), or a comma-separated list (completed,failed). sort=recent lists
 * the last changed first (default: by product). include=active adds `active`, the images in
 * flight (claimed for processing, at most 12, longest-running first). limit is at most 100
 * (default 50). Each image has `thumbnailUrl` (the original, small) and, once processed,
 * `outputImageUrl` (a signed preview). 404 for another shop's job. The job page's cleaning
 * strip polls ACTIVITY_QUERY (status=ready,flagged,unchanged,failed&sort=recent&limit=6&include=active)
 * while the job is processing.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { shop } = await requireApiShop(request);
    const page = await listApiItems(shop.id, params.jobId ?? "", new URL(request.url).searchParams);
    if (!page) throw jobNotFound();
    return apiJson(page);
  } catch (error) {
    return apiError(error);
  }
};
