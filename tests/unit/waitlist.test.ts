import { beforeEach, describe, expect, it, vi } from "vitest";
// Static, so the (slow, cold) module load happens at collection and not inside the first
// test's timeout. vi.mock calls below are hoisted above it.
import { action } from "../../app/routes/_index/route";

const { counters, upsert, redisDown } = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  upsert: vi.fn(async () => ({})),
  // Like ioredis with maxRetriesPerRequest: null while Redis is down: commands never settle.
  redisDown: { value: false },
}));

vi.mock("../../app/lib/redis.server", () => ({
  redis: () => ({
    incr: async (k: string) => {
      if (redisDown.value) return new Promise<number>(() => {});
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n;
    },
    expire: async () => 1,
  }),
}));
vi.mock("../../app/db.server", () => ({ default: { waitlist: { upsert } } }));
vi.mock("../../app/shopify.server", () => ({}));

const post = (body: string, ip = "203.0.113.9") =>
  new Request("https://images.qancha.live/?index", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip,
    },
  });

async function run(req: Request) {
  const res = await action({ request: req, params: {}, context: {} } as never);
  // data() results carry { data, init }
  if (res && typeof res === "object" && "init" in res)
    return {
      status: (res as { init: { status: number } }).init.status,
      body: (res as { data: unknown }).data,
    };
  return { status: 200, body: res };
}

describe("waitlist action", () => {
  beforeEach(() => {
    counters.clear();
    upsert.mockClear();
    redisDown.value = false;
  });

  it("allows 5 sign-ups per IP per day, then answers 429 without writing", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await run(post(`email=a${i}%40example.com&interest=web`));
      expect(r.body).toEqual({ ok: true });
    }
    const sixth = await run(post("email=a6%40example.com&interest=web"));
    expect(sixth.status).toBe(429);
    expect(String((sixth.body as { error: string }).error)).toMatch(/tomorrow/);
    expect(upsert).toHaveBeenCalledTimes(5);
    // another IP is unaffected
    const other = await run(post("email=b%40example.com", "198.51.100.7"));
    expect(other.body).toEqual({ ok: true });
  });

  it("rejects a body over 16 KB before parsing it", async () => {
    const big = "email=a%40b.co&x=" + "a".repeat(17 * 1024);
    const r = await run(post(big));
    expect(r.status).toBe(413);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("invalid emails don't use up the daily allowance", async () => {
    const r = await run(post("email=nope"));
    expect(r.body).toHaveProperty("error");
    expect(counters.size).toBe(0);
  });

  it("fails open after a short wait when Redis doesn't answer", async () => {
    redisDown.value = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = Date.now();
      const r = await run(post("email=c%40example.com"));
      expect(r.body).toEqual({ ok: true });
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      log.mockRestore();
    }
  }, 10_000);

  it("honeypot submissions are accepted silently and not stored", async () => {
    const r = await run(post("email=bot%40example.com&company=Acme"));
    expect(r.body).toEqual({ ok: true });
    expect(upsert).not.toHaveBeenCalled();
  });
});
