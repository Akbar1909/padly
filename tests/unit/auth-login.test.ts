import type { LoaderFunctionArgs } from "react-router";
import { describe, expect, it, vi } from "vitest";
// Static, so the (slow, cold) Shopify library load happens at collection and not inside the
// first test's timeout. The vi.mock below is hoisted above it.
import { action, loader } from "../../app/routes/auth.login/route";

// Unit tests have no database: keep the session storage from polling one.
vi.mock("@shopify/shopify-app-session-storage-prisma", () => ({
  PrismaSessionStorage: class {
    isReady = async () => true;
  },
}));

describe("login route (no shop-domain form)", () => {
  const get = (query = "") => new Request(`https://vio.example.com/auth/login${query}`);

  // The loader and action throw or return redirects; both are Responses.
  async function respond(fn: () => Promise<unknown> | unknown): Promise<Response> {
    try {
      return (await fn()) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  }
  const load = (request: Request) =>
    respond(() => loader({ request, params: {}, context: {} } as LoaderFunctionArgs));

  it("sends a visit without a shop to the website", async () => {
    const res = await load(get());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("sends a request that carries a shop into Shopify's install flow", async () => {
    const res = await load(get("?shop=x.myshopify.com"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://admin.shopify.com/store/x/oauth/install?client_id=test-api-key");
  });

  it("sends an invalid shop to the website", async () => {
    const res = await load(get("?shop=evil.example.com"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("redirects a POST to the website", async () => {
    const res = await respond(() => action());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("never renders a shop-domain field", async () => {
    for (const res of [await load(get()), await load(get("?shop=x.myshopify.com"))]) {
      expect(await res.text()).not.toMatch(/name="shop"/);
    }
  });
});
