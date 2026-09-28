import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { methodNotAllowed, verifyWebhook } from "../lib/webhooks.server";

export const loader = methodNotAllowed;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await verifyWebhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current;
  if (Array.isArray(current)) {
    await db.session.updateMany({
      where: { shop },
      data: { scope: current.join(",") },
    });
  }
  return new Response();
};
