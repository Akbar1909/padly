import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import { BillingError, confirmPurchase, createPurchase, type AdminGraphql } from "../../app/lib/billing.server";
import { redis } from "../../app/lib/redis.server";
import { makeShop, resetState } from "./helpers";

const SHOP = "billing.myshopify.com";
const START_FAILED = /Shopify couldn't start the purchase/;

/** The `admin` object from authenticate.admin(), answering the purchase mutation with `create`. */
function fakeAdmin(create: () => unknown | Promise<unknown>): AdminGraphql & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async graphql(query) {
      queries.push(query);
      if (query.includes("ShopPlan")) {
        return Response.json({ data: { shop: { plan: { partnerDevelopment: true } } } });
      }
      return Response.json(await create());
    },
  };
}

const created = (payload: object) => ({ data: { appPurchaseOneTimeCreate: payload } });

beforeEach(resetState);
afterAll(async () => {
  await redis().quit();
  await prisma.$disconnect();
});

describe("starting a credit pack purchase", () => {
  // The Shopify details are logged; keep the test output quiet.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  it("returns Shopify's confirmation URL and remembers the charge", async () => {
    const shop = await makeShop(SHOP);
    const admin = fakeAdmin(() =>
      created({
        appPurchaseOneTime: { id: "gid://shopify/AppPurchaseOneTime/1", status: "PENDING" },
        confirmationUrl: "https://billing.myshopify.com/admin/charges/1/confirm",
        userErrors: [],
      }),
    );
    expect(await createPurchase(admin, shop, "growth")).toBe("https://billing.myshopify.com/admin/charges/1/confirm");
    const [purchase] = await prisma.purchase.findMany({ where: { shopId: shop.id } });
    expect(purchase).toMatchObject({ pack: "growth", credits: 1500, status: "pending", shopifyChargeId: "gid://shopify/AppPurchaseOneTime/1" });
  });

  it("turns Shopify's userErrors into a BillingError and closes the purchase row", async () => {
    const shop = await makeShop(SHOP);
    const admin = fakeAdmin(() =>
      created({ appPurchaseOneTime: null, confirmationUrl: null, userErrors: [{ field: ["price"], message: "Price is invalid" }] }),
    );
    const err = await createPurchase(admin, shop, "starter").catch((e) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect(err.message).toMatch(START_FAILED);
    expect(err.message).not.toMatch(/Price is invalid/); // Shopify's wording stays in the log
    const [purchase] = await prisma.purchase.findMany({ where: { shopId: shop.id } });
    expect(purchase.status).toBe("declined");
  });

  it("gives a BillingError when Shopify returns no confirmation URL", async () => {
    const shop = await makeShop(SHOP);
    const admin = fakeAdmin(() =>
      created({ appPurchaseOneTime: { id: "gid://shopify/AppPurchaseOneTime/2", status: "PENDING" }, confirmationUrl: null, userErrors: [] }),
    );
    await expect(createPurchase(admin, shop, "starter")).rejects.toBeInstanceOf(BillingError);
    expect((await prisma.purchase.findFirstOrThrow({ where: { shopId: shop.id } })).status).toBe("declined");
  });

  it("refuses an unknown pack without creating anything", async () => {
    const shop = await makeShop(SHOP);
    const admin = fakeAdmin(() => {
      throw new Error("should not be called");
    });
    const err = await createPurchase(admin, shop, "nope").catch((e) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect(err.message).toMatch(/isn't available/);
    expect(admin.queries).toEqual([]);
    expect(await prisma.purchase.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it("passes the admin client's Response through unchanged (re-authentication)", async () => {
    const shop = await makeShop(SHOP);
    const reauth = new Response(null, { status: 401 });
    const admin = fakeAdmin(() => {
      throw reauth;
    });
    await expect(createPurchase(admin, shop, "starter")).rejects.toBe(reauth);
    expect((await prisma.purchase.findFirstOrThrow({ where: { shopId: shop.id } })).status).toBe("declined");
  });

  it("turns any other failure (network, bad JSON) into a BillingError", async () => {
    const shop = await makeShop(SHOP);
    const admin = fakeAdmin(() => {
      throw new Error("fetch failed");
    });
    const err = await createPurchase(admin, shop, "catalog").catch((e) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect(err.message).toMatch(START_FAILED);
    expect(err.message).not.toMatch(/fetch failed/);
  });
});

describe("confirming a purchase after the merchant returns", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  async function pending() {
    const shop = await makeShop(SHOP, 0);
    const purchase = await prisma.purchase.create({
      data: { shopId: shop.id, pack: "starter", credits: 300, amount: 9, shopifyChargeId: "gid://shopify/AppPurchaseOneTime/7" },
    });
    return { shop, purchase };
  }

  it("credits an approved charge once", async () => {
    const { shop, purchase } = await pending();
    const admin: AdminGraphql = { graphql: async () => Response.json({ data: { node: { status: "ACTIVE" } } }) };
    expect(await confirmPurchase(admin, shop.id, purchase.id)).toEqual({ status: "active", credits: 300 });
    expect(await confirmPurchase(admin, shop.id, purchase.id)).toEqual({ status: "active", credits: 300 });
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(300);
  });

  it("gives a BillingError, not a crash, when Shopify can't say", async () => {
    const { shop, purchase } = await pending();
    const admin: AdminGraphql = { graphql: async () => Response.json({ errors: [{ message: "Internal error" }] }) };
    await expect(confirmPurchase(admin, shop.id, purchase.id)).rejects.toBeInstanceOf(BillingError);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(0);
  });

  it("never confirms another shop's purchase", async () => {
    const { purchase } = await pending();
    const other = await makeShop("other-billing.myshopify.com");
    const admin: AdminGraphql = { graphql: async () => Response.json({ data: { node: { status: "ACTIVE" } } }) };
    expect(await confirmPurchase(admin, other.id, purchase.id)).toBeNull();
  });
});
