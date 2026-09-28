import type { ActionFunctionArgs } from "react-router";
import { handlePurchaseWebhook } from "../lib/billing.server";
import { methodNotAllowed, verifyWebhook } from "../lib/webhooks.server";

export const loader = methodNotAllowed;

/** Credits a pack even if the merchant never comes back through the return URL. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await verifyWebhook(request);
  const purchase = payload.app_purchase_one_time as { admin_graphql_api_id?: string; status?: string } | undefined;
  if (purchase?.admin_graphql_api_id && purchase.status) {
    await handlePurchaseWebhook(shop, purchase.admin_graphql_api_id, purchase.status);
  }
  return new Response();
};
