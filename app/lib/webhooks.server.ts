import { createHmac, timingSafeEqual } from "node:crypto";

/** Our webhook payloads are a few KB; anything this big isn't from Shopify. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

export interface VerifiedWebhook {
  /** Normalised like the Shopify library does: "shop/redact" → "SHOP_REDACT". */
  topic: string;
  shop: string;
  webhookId: string | null;
  triggeredAt: Date | null;
  payload: Record<string, unknown>;
}

/**
 * Verify a webhook's HMAC without loading the shop's session.
 *
 * `authenticate.webhook` also loads the offline session and, with expiring
 * offline tokens, refreshes it when expired. After an uninstall the refresh
 * can never succeed, so it answers 500 and app/uninstalled and shop/redact
 * would never be processed. None of our webhooks call the Admin API, so they
 * only need the signature check.
 */
export async function verifyWebhook(
  request: Request,
  secret = process.env.SHOPIFY_API_SECRET ?? "",
): Promise<VerifiedWebhook> {
  if (request.method !== "POST") {
    throw new Response(null, { status: 405, statusText: "Method Not Allowed" });
  }
  const header = (name: string) =>
    request.headers.get(`x-shopify-${name}`) ?? request.headers.get(`shopify-${name}`);

  const hmac = header("hmac-sha256");
  if (!secret || !hmac) throw new Response(null, { status: 401, statusText: "Unauthorized" });

  // The body is read before the signature can be checked, so bound it. Shopify
  // sends Content-Length, but a proxy hop may re-chunk the body: then count
  // bytes as they arrive instead of refusing (a refusal would lose every webhook).
  const length = request.headers.get("content-length");
  if (length !== null) {
    const size = Number(length);
    if (!Number.isInteger(size) || size < 0 || size > WEBHOOK_MAX_BYTES) throw tooLarge();
  }
  const rawBody = await readCapped(request, WEBHOOK_MAX_BYTES);

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(hmac, "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Response(null, { status: 401, statusText: "Unauthorized" });
  }

  const topic = header("topic");
  const shop = header("shop-domain");
  if (!topic || !shop) throw new Response(null, { status: 400, statusText: "Bad Request" });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Response(null, { status: 400, statusText: "Bad Request" });
  }

  const triggered = header("triggered-at");
  const triggeredAt = triggered ? new Date(triggered) : null;
  return {
    topic: topic.toUpperCase().replace(/[/.]/g, "_"),
    shop,
    webhookId: header("webhook-id"),
    triggeredAt: triggeredAt && !Number.isNaN(triggeredAt.getTime()) ? triggeredAt : null,
    payload,
  };
}

const tooLarge = () => new Response(null, { status: 413, statusText: "Payload Too Large" });

/** The raw body, or 413 as soon as it passes `max` bytes (whatever Content-Length said). */
async function readCapped(request: Request, max: number): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Webhook routes only accept POST. */
export const methodNotAllowed = () => new Response(null, { status: 405 });
