import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANY,
  buildProductSearchQuery,
  describeFilter,
  parseFilterForm,
  searchValue,
} from "../../app/lib/filters";
import { signBody } from "../../app/lib/gpu.server";
import { nextJobStatus } from "../../app/lib/jobs.server";
import {
  creditsFor,
  DEFAULT_PRESET,
  isUpscaleEligible,
  parsePresetForm,
} from "../../app/lib/presets";
import {
  currentExtension,
  extensionMatchesFormat,
} from "../../app/lib/shopify/files.server";
import { projectedAvailable, waitMsFor } from "../../app/lib/shopify/throttle";
import {
  clientIp,
  isOwner,
  isOwnerToken,
  ownerCookie,
  sniffImage,
} from "../../app/lib/try.server";

describe("throttle pacing", () => {
  const state = { available: 50, max: 1000, rate: 100, ts: 0 };

  it("refills at restoreRate up to the maximum", () => {
    expect(projectedAvailable(state, 1000)).toBe(150);
    expect(projectedAvailable(state, 60_000)).toBe(1000);
  });

  it("waits only for the missing points", () => {
    expect(waitMsFor(state, 40, 0)).toBe(0);
    expect(waitMsFor(state, 250, 0)).toBe(2000); // 200 missing at 100/s
    expect(waitMsFor(state, 250, 1000)).toBe(1000);
  });

  it("never waits without state and caps cost at the bucket size", () => {
    expect(waitMsFor(null, 500, 0)).toBe(0);
    expect(waitMsFor({ ...state, available: 0 }, 5000, 0)).toBe(10_000);
  });
});

describe("product search query", () => {
  it("combines filters with AND and quotes values", () => {
    expect(
      buildProductSearchQuery({
        collectionId: "gid://shopify/Collection/123",
        vendor: "Supplier X",
        productType: "Shoes",
        tag: "summer",
        imageScope: "first",
      }),
    ).toBe(
      'collection_id:123 AND vendor:"Supplier X" AND product_type:"Shoes" AND tag:"summer"',
    );
  });

  it("escapes quotes and backslashes so values can't break out", () => {
    expect(searchValue('Bob\'s "Best" \\ Co')).toBe(
      '"Bob\'s \\"Best\\" \\\\ Co"',
    );
  });

  it("is empty for the whole catalog and rejects bad collection ids", () => {
    expect(buildProductSearchQuery({ imageScope: "all" })).toBe("");
    expect(() =>
      buildProductSearchQuery({ collectionId: "1 OR 1", imageScope: "all" }),
    ).toThrow();
  });

  it("treats the picker's 'Any …' options as no filter", () => {
    const form = new FormData();
    form.set("collectionId", ANY);
    form.set("vendor", "bambilbaby");
    form.set("productType", ANY);
    form.set("imageScope", "first");
    const parsed = parseFilterForm(form);
    expect(parsed.success && parsed.data).toEqual({
      vendor: "bambilbaby",
      imageScope: "first",
    });
    expect(buildProductSearchQuery(parsed.data!)).toBe('vendor:"bambilbaby"');
  });

  it("rejects a collection that isn't an id (e.g. a submitted option label)", () => {
    const form = new FormData();
    form.set("collectionId", "Any collection");
    const parsed = parseFilterForm(form);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]).toMatchObject({
      path: ["collectionId"],
      message: "Choose a collection from the list",
    });
    form.set("collectionId", "gid://shopify/Collection/330671784119");
    expect(parseFilterForm(form).success).toBe(true);
  });

  it("parses the form and describes the selection", () => {
    const form = new FormData();
    form.set("vendor", "  Acme ");
    form.set("imageScope", "all");
    form.set("tag", "");
    const parsed = parseFilterForm(form);
    expect(parsed.success && parsed.data).toEqual({
      vendor: "Acme",
      imageScope: "all",
    });
    expect(describeFilter({ vendor: "Acme", imageScope: "all" })).toBe(
      "vendor “Acme” · all images",
    );
  });
});

describe("presets and credits", () => {
  it("reads unchecked checkboxes as false", () => {
    const form = new FormData();
    form.set("aspect", "4:5");
    form.set("marginPct", "10");
    form.set("bgColor", "#ffffff");
    form.set("removeBg", "on");
    const parsed = parsePresetForm(form);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      aspect: "4:5",
      marginPct: 10,
      bgColor: "#FFFFFF",
      removeBg: true,
      upscale: false,
      aiMetadata: false,
    });
  });

  it("rejects out-of-range values", () => {
    const form = new FormData();
    form.set("marginPct", "60");
    form.set("bgColor", "white");
    const parsed = parsePresetForm(form);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.map((i) => i.path[0]).sort()).toEqual([
      "bgColor",
      "marginPct",
    ]);
  });

  it("charges 1 credit per image, +1 only when AI upscaling runs", () => {
    expect(creditsFor(false)).toBe(1);
    expect(creditsFor(true)).toBe(2);
  });

  it("only upscales when opted in and the short side is under the threshold", () => {
    const on = { ...DEFAULT_PRESET, upscale: true, upscaleThresholdPx: 1200 };
    expect(isUpscaleEligible(on, 2000, 900)).toBe(true);
    expect(isUpscaleEligible(on, 2000, 1200)).toBe(false);
    expect(isUpscaleEligible({ ...on, upscale: false }, 500, 500)).toBe(false);
    expect(isUpscaleEligible(on, null, 500)).toBe(false);
  });
});

describe("in-place replace format rules", () => {
  it("reads the extension from the CDN URL, falling back to the MIME type", () => {
    expect(
      currentExtension({
        imageUrl:
          "https://cdn.shopify.com/s/files/1/0001/products/shoe.JPG?v=123",
        originalUrl: null,
        mimeType: "image/jpeg",
      }),
    ).toBe("jpg");
    expect(
      currentExtension({
        imageUrl: null,
        originalUrl: null,
        mimeType: "image/webp",
      }),
    ).toBe("webp");
  });

  it("only allows same-format replacement", () => {
    expect(extensionMatchesFormat("jpg", "jpeg")).toBe(true);
    expect(extensionMatchesFormat("jpeg", "jpeg")).toBe(true);
    expect(extensionMatchesFormat("png", "png")).toBe(true);
    expect(extensionMatchesFormat("png", "jpeg")).toBe(false);
    expect(extensionMatchesFormat("heic", "jpeg")).toBe(false);
    expect(extensionMatchesFormat(null, "jpeg")).toBe(false);
  });
});

describe("GPU request signing", () => {
  it("signs '<t>.<body>' with HMAC-SHA256", () => {
    const body = '{"request_id":"x"}';
    const expected = createHmac("sha256", "s3cret")
      .update(`1700000000.${body}`)
      .digest("hex");
    expect(signBody("s3cret", body, 1700000000)).toBe(
      `t=1700000000,v1=${expected}`,
    );
  });
});

describe("job phase transitions", () => {
  it("moves processing → review once nothing is queued or in flight", () => {
    expect(nextJobStatus("processing", { queued: 1, ready: 3 })).toBe(
      "processing",
    );
    expect(nextJobStatus("processing", { processing: 1 })).toBe("processing");
    expect(
      nextJobStatus("processing", { ready: 2, flagged: 1, failed: 1 }),
    ).toBe("review");
  });

  it("finishes a job where every image failed", () => {
    expect(nextJobStatus("processing", { failed: 4 })).toBe("done");
  });

  it("returns to review after applying if unapproved images remain, else done", () => {
    expect(nextJobStatus("applying", { applying: 1, applied: 2 })).toBe(
      "applying",
    );
    expect(nextJobStatus("applying", { applied: 2, flagged: 1 })).toBe(
      "review",
    );
    expect(
      nextJobStatus("applying", { applied: 2, rejected: 3, failed: 1 }),
    ).toBe("done");
  });

  it("leaves other phases alone", () => {
    expect(nextJobStatus("review", {})).toBe("review");
    expect(nextJobStatus("done", {})).toBe("done");
  });
});

describe("try-it uploads", () => {
  it("identifies images by their bytes, not their name", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      mime: "image/jpeg",
      ext: "jpg",
    });
    expect(
      sniffImage(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffImage(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toEqual({
      mime: "image/webp",
      ext: "webp",
    });
    expect(sniffImage(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  it("takes the visitor IP from the first X-Forwarded-For hop", () => {
    const req = (h: Record<string, string>) =>
      new Request("https://x.test/try", { headers: h });
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(req({ "x-real-ip": "198.51.100.3" }))).toBe("198.51.100.3");
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("owner mode (unlimited tries)", () => {
  const secret = "owner-secret-0123456789";
  const cookieFrom = (setCookie: string) => setCookie.split(";")[0];

  it("only accepts the exact owner token", () => {
    expect(isOwnerToken(secret, secret)).toBe(true);
    expect(isOwnerToken("owner-secret-0123456788", secret)).toBe(false);
    expect(isOwnerToken(null, secret)).toBe(false);
    expect(isOwnerToken(secret, undefined)).toBe(false); // feature off when unset
  });

  it("recognises the owner cookie and rejects forged or foreign ones", () => {
    const cookie = cookieFrom(ownerCookie(secret));
    expect(ownerCookie(secret)).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const req = (c: string) =>
      new Request("https://x.test/try", { headers: { cookie: c } });
    expect(isOwner(req(`theme=dark; ${cookie}`), secret)).toBe(true);
    expect(isOwner(req("vio_owner=deadbeef"), secret)).toBe(false);
    expect(isOwner(req(cookie), "another-secret-0123456789")).toBe(false);
    expect(isOwner(req(cookie), undefined)).toBe(false);
  });
});
