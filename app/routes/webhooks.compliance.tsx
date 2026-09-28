import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { enqueueJobTask, purgeTaskId, verifyTaskId } from "../lib/queue.server";
import { methodNotAllowed, verifyWebhook } from "../lib/webhooks.server";

export const loader = methodNotAllowed;

/**
 * Mandatory privacy webhooks. We never read customers or orders, so the two
 * customer topics have nothing to return or erase. shop/redact erases
 * everything we hold for the store: DB rows and every stored image.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await verifyWebhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      break;
    case "SHOP_REDACT": {
      const record = await db.shop.findUnique({ where: { domain: shop } });
      if (!record) {
        await db.session.deleteMany({ where: { shop } });
        break;
      }
      // Record the request first so maintenance keeps retrying until the data is gone.
      await db.shop.update({ where: { id: record.id }, data: { redactRequestedAt: new Date() } });
      if (record.uninstalledAt) {
        await db.session.deleteMany({ where: { shop } });
        await enqueueJobTask({ name: "purge-shop", shopId: record.id }, { jobId: purgeTaskId(record.id) });
      } else {
        // We think the app is installed. Either the merchant reinstalled (keep
        // their data) or the app/uninstalled delivery was lost. Ask Shopify:
        // the worker purges if our token is refused, else clears the request.
        console.warn(`shop/redact for ${shop}, which looks installed; checking with Shopify`);
        await enqueueJobTask(
          { name: "verify-uninstalled", shopId: record.id, reason: "redact" },
          { jobId: verifyTaskId(record.id) },
        );
      }
      break;
    }
  }
  return new Response();
};
