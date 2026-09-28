import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { markUninstalled } from "../lib/shops.server";
import { methodNotAllowed, verifyWebhook } from "../lib/webhooks.server";

export const loader = methodNotAllowed;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, triggeredAt } = await verifyWebhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const record = await db.shop.findUnique({ where: { domain: shop } });

  // Shopify retries a failed delivery up to 8 times over about 4 hours. A
  // retry of an uninstall that happened before the latest (re)install must
  // not undo that install.
  if (record && triggeredAt && record.installedAt > triggeredAt) {
    console.log(`Ignoring stale ${topic} for ${shop}: reinstalled since`);
    return new Response();
  }

  await db.session.deleteMany({ where: { shop } });

  if (record) {
    // Stop work in progress. Backups stay until shop/redact (48 h after the
    // uninstall) so a quick reinstall can still restore. Safe to replay.
    await markUninstalled(record.id, triggeredAt ?? new Date());
  }

  return new Response();
};
