import type { ActionFunctionArgs } from "react-router";
import {
  apiError,
  apiJson,
  apiMethodNotAllowed,
  bulkAcceptedBody,
  idempotencyKeyFrom,
  parseBulkRequest,
  readJsonBody,
  requireApiShop,
  resolvePreset,
} from "../lib/api.server";
import { env } from "../lib/env.server";
import { createJob } from "../lib/jobs.server";

export const loader = () => apiMethodNotAllowed("POST");

/**
 * POST /api/image-jobs/bulk: create a job for products (and optionally exactly some of their
 * images). Header `Idempotency-Key` is required; a replayed key (per shop) returns the first
 * job with 200 instead of 202, whatever the body says.
 *
 * Body: {productIds: string[] (numeric or gid), mediaIds?: string[] (alias imageIds),
 * imageScope?: "first" | "all", preset?: partial preset, autoStart?: boolean = true}.
 * Answers 202 {jobId, status: "queued", total} right away: the worker reads the products,
 * and with autoStart it starts processing (reserving credits, never writing to Shopify).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    if (request.method !== "POST") return apiMethodNotAllowed("POST");
    const { shop } = await requireApiShop(request);
    const requestKey = idempotencyKeyFrom(request);
    const bulk = parseBulkRequest(await readJsonBody(request), env().MAX_ITEMS_PER_JOB);
    const preset = await resolvePreset(shop.id, bulk.preset);
    const job = await createJob(shop.id, bulk.filter, preset, {
      requestKey,
      autoStart: bulk.autoStart,
      source: "api",
    });
    return apiJson(bulkAcceptedBody(job), job.created ? 202 : 200, {
      Location: `/api/image-jobs/${job.id}`,
      ...(job.created ? {} : { "Idempotent-Replayed": "true" }),
    });
  } catch (error) {
    return apiError(error);
  }
};
