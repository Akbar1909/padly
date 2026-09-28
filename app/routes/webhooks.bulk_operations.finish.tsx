import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { enqueueJobTask } from "../lib/queue.server";
import { methodNotAllowed, verifyWebhook } from "../lib/webhooks.server";

export const loader = methodNotAllowed;

/** A bulk read finished: hand it to the worker, which fetches the result URL and ingests it. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await verifyWebhook(request);
  const bulkId = payload.admin_graphql_api_id;

  if (typeof bulkId === "string") {
    const job = await db.job.findFirst({ where: { bulkOperationId: bulkId, shop: { domain: shop } } });
    if (job && job.status === "reading") {
      await enqueueJobTask({ name: "ingest-bulk", jobId: job.id, url: null }, { jobId: `ingest-${job.id}` });
    }
  }
  return new Response();
};
