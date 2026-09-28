import prisma from "../db.server";
import { lockShop, recordLedger } from "./credits.server";
import { env } from "./env.server";

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  price: number; // USD
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", name: "Starter pack", credits: 300, price: 9 },
  { id: "growth", name: "Growth pack", credits: 1500, price: 29 },
  { id: "catalog", name: "Catalog pack", credits: 5000, price: 79 },
];

/**
 * A purchase couldn't be started or checked. The message is safe to show the
 * merchant as is; the Shopify details are logged.
 */
export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

const START_FAILED =
  "Shopify couldn't start the purchase. Try again, or contact support if it keeps happening.";

/** Minimal shape of the `admin` object from authenticate.admin(). */
export interface AdminGraphql {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
}

async function isDevelopmentStore(admin: AdminGraphql): Promise<boolean> {
  const res = await admin.graphql(
    `#graphql
    query ShopPlan { shop { plan { partnerDevelopment } } }`,
  );
  const json = (await res.json()) as { data?: { shop?: { plan?: { partnerDevelopment?: boolean } } } };
  return json.data?.shop?.plan?.partnerDevelopment === true;
}

/** Where Shopify sends the merchant after approving: back inside the embedded app. */
export function billingReturnUrl(shopDomain: string, purchaseId: string): string {
  const store = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}/apps/${env().SHOPIFY_API_KEY}/app/billing?purchase=${purchaseId}`;
}

/**
 * Create a pending purchase and the Shopify one-time charge. Returns the
 * confirmation URL. Throws BillingError when Shopify refuses or can't be
 * reached (Responses from the admin client, e.g. re-auth, pass through).
 */
export async function createPurchase(
  admin: AdminGraphql,
  shop: { id: string; domain: string },
  packId: string,
): Promise<string> {
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new BillingError("That credit pack isn't available. Reload the page and pick a pack.");

  let purchaseId: string | null = null;
  try {
    // Development stores can only take test charges (this includes App Store review).
    const test = env().BILLING_TEST || (await isDevelopmentStore(admin));
    const purchase = await prisma.purchase.create({
      data: { shopId: shop.id, pack: pack.id, credits: pack.credits, amount: pack.price, test },
    });
    purchaseId = purchase.id;

    const res = await admin.graphql(
      `#graphql
      mutation BuyCredits($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean) {
        appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
          appPurchaseOneTime { id status }
          confirmationUrl
          userErrors { field message }
        }
      }`,
      {
        variables: {
          name: `${pack.name}: ${pack.credits.toLocaleString("en-US")} credits`,
          price: { amount: pack.price.toFixed(2), currencyCode: "USD" },
          returnUrl: billingReturnUrl(shop.domain, purchase.id),
          test,
        },
      },
    );
    const json = (await res.json()) as {
      data?: {
        appPurchaseOneTimeCreate?: {
          appPurchaseOneTime: { id: string; status: string } | null;
          confirmationUrl: string | null;
          userErrors: Array<{ field?: string[] | null; message: string }>;
        } | null;
      };
      errors?: unknown;
    };
    const payload = json.data?.appPurchaseOneTimeCreate;
    if (!payload?.confirmationUrl || !payload.appPurchaseOneTime || payload.userErrors.length) {
      console.error("appPurchaseOneTimeCreate refused", {
        shop: shop.domain,
        pack: pack.id,
        userErrors: payload?.userErrors,
        errors: json.errors,
      });
      throw new BillingError(START_FAILED);
    }
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { shopifyChargeId: payload.appPurchaseOneTime.id },
    });
    return payload.confirmationUrl;
  } catch (error) {
    // No charge was created: close the row so it doesn't stay pending forever.
    if (purchaseId) {
      await prisma.purchase.update({ where: { id: purchaseId }, data: { status: "declined" } }).catch(() => {});
    }
    if (error instanceof Response) throw error; // e.g. the admin client asking to re-authenticate
    if (error instanceof BillingError) throw error;
    console.error("createPurchase failed", { shop: shop.domain, pack: pack.id, error });
    throw new BillingError(START_FAILED);
  }
}

/**
 * Record a charge status from Shopify. Credits the shop exactly once when the
 * charge becomes ACTIVE, however many times this runs (return URL + webhook).
 */
export async function applyPurchaseStatus(purchaseId: string, shopifyStatus: string): Promise<void> {
  const status = shopifyStatus.toLowerCase();
  const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId } });
  if (!purchase) return;

  if (status !== "active") {
    if (!purchase.creditedAt) {
      await prisma.purchase.update({ where: { id: purchaseId }, data: { status } });
    }
    return;
  }

  await prisma.$transaction(async (tx) => {
    await lockShop(tx, purchase.shopId);
    await recordLedger(tx, {
      shopId: purchase.shopId,
      delta: purchase.credits,
      reason: "purchase",
      idempotencyKey: `purchase:${purchase.id}`,
      purchaseId: purchase.id,
      note: CREDIT_PACKS.find((p) => p.id === purchase.pack)?.name ?? `${purchase.pack} pack`,
    });
    await tx.purchase.update({
      where: { id: purchase.id },
      data: { status: "active", creditedAt: purchase.creditedAt ?? new Date() },
    });
  });
}

/** Check the charge with Shopify (merchant just came back from the confirmation page). */
export async function confirmPurchase(
  admin: AdminGraphql,
  shopId: string,
  purchaseId: string,
): Promise<{ status: string; credits: number } | null> {
  const purchase = await prisma.purchase.findFirst({ where: { id: purchaseId, shopId } });
  if (!purchase?.shopifyChargeId) return null;
  if (purchase.creditedAt) return { status: "active", credits: purchase.credits };

  const res = await admin.graphql(
    `#graphql
    query PurchaseStatus($id: ID!) {
      node(id: $id) { ... on AppPurchaseOneTime { id status } }
    }`,
    { variables: { id: purchase.shopifyChargeId } },
  );
  const json = (await res.json()) as { data?: { node?: { status?: string } | null }; errors?: unknown };
  const status = json.data?.node?.status;
  if (!status) {
    if (json.errors) {
      console.error("purchase status check failed", { purchaseId, errors: json.errors });
      throw new BillingError(
        "We're confirming your purchase with Shopify. Your credits will appear within a minute.",
      );
    }
    return null;
  }
  await applyPurchaseStatus(purchase.id, status);
  return { status: status.toLowerCase(), credits: purchase.credits };
}

/** From the app_purchases_one_time/update webhook. */
export async function handlePurchaseWebhook(shopDomain: string, chargeGid: string, status: string): Promise<void> {
  const purchase = await prisma.purchase.findFirst({
    where: { shopifyChargeId: chargeGid, shop: { domain: shopDomain } },
  });
  if (purchase) await applyPurchaseStatus(purchase.id, status);
}
