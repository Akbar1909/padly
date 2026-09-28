/**
 * End to end through the real worker task code, real Postgres/Redis/MinIO and
 * the real GPU service (classic backend). Only Shopify is mocked, via undici's
 * MockAgent on the global fetch dispatcher.
 *
 * Start the GPU service first (see gpu-service/README.md), e.g.
 *   cd gpu-service && MODEL_BACKEND=classic GPU_SERVICE_SECRET=test-gpu-secret ALLOW_HTTP_URLS=1 \
 *     .venv/bin/uvicorn app.main:app --port 58123
 *
 * Without the service these tests are skipped. Set REQUIRE_GPU_E2E=1 (CI) to fail instead:
 * this is the only end-to-end check of the source hash, the result key, the notifications and
 * the apply_backup_missing path.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import prisma from "../../app/db.server";
import { getCreditSummary } from "../../app/lib/credits.server";
import type { GpuFlag } from "../../app/lib/gpu.server";
import { applyApproved, createJob, decideItems, restoreItems, retryStronger, startJob } from "../../app/lib/jobs.server";
import { listUnreadNotifications } from "../../app/lib/notifications.server";
import { DEFAULT_PRESET } from "../../app/lib/presets";
import { resultStatus, type ProcessingRecord } from "../../app/lib/processing";
import { itemsQueue, jobsQueue, type ItemTask } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { deletePrefix, getObjectBuffer, headObject, keys } from "../../app/lib/storage.server";
import { afterItemTask, markItemFailed, runItemTask } from "../../worker/tasks/items";
import { readJob } from "../../worker/tasks/jobs";
import { makeShop, resetState } from "./helpers";

const GPU_URL = process.env.GPU_SERVICE_URL!;
const gpuUp = await fetch(new URL("/healthz", GPU_URL))
  .then((r) => r.ok)
  .catch(() => false);

// ── tiny PNG encoder for test fixtures ─────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function pngSize(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// An off-centre red "product" on a white background.
const ORIGINAL = png(900, 600, (x, y) => (x >= 100 && x < 400 && y >= 150 && y < 450 ? [200, 30, 40] : [255, 255, 255]));

// ── fake Shopify ───────────────────────────────────────────────────────────
const SHOP = "e2e-shop.myshopify.com";
const PRODUCT = "gid://shopify/Product/100";
const MEDIA = "gid://shopify/MediaImage/200";

interface FakeShopify {
  ops: string[];
  fileUpdateRejects: boolean;
  staged: number[];
  fileSize: number;
  productMedia: string[];
  variantsOn: Record<string, string[]>;
}
const fake: FakeShopify = {
  ops: [],
  fileUpdateRejects: false,
  staged: [],
  fileSize: ORIGINAL.length,
  productMedia: [MEDIA],
  variantsOn: {},
};

function mediaNode(id: string) {
  return {
    id,
    alt: "Red box",
    fileStatus: "READY",
    mimeType: "image/png",
    image: { url: `https://cdn.shopify.com/s/files/1/products/red-box.png?v=1`, width: 900, height: 600 },
    originalSource: { url: `https://cdn.test/original.png`, fileSize: fake.fileSize },
    fileErrors: [],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture variables
type Vars = Record<string, any>;

function graphql(body: { query: string; variables?: Vars }) {
  const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "anonymous";
  const v = body.variables ?? {};
  fake.ops.push(op);
  switch (op) {
    case "CountProducts":
      return { productsCount: { count: 1 } };
    case "ReadProducts":
      return {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: PRODUCT,
              title: "Red box",
              media: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ ...mediaNode(MEDIA), mediaContentType: "IMAGE", status: "READY" }],
              },
            },
          ],
        },
      };
    case "LiveMedia":
      return { node: mediaNode(v.id) };
    case "StageUpload":
      return {
        stagedUploadsCreate: {
          stagedTargets: [
            {
              url: "https://upload.test/stage",
              resourceUrl: `https://upload.test/resource/${v.input[0].filename}`,
              parameters: [{ name: "key", value: "tmp/abc" }],
            },
          ],
          userErrors: [],
        },
      };
    case "ReplaceFile":
      if (fake.fileUpdateRejects) {
        return { fileUpdate: { files: null, userErrors: [{ field: ["files"], message: "Extension mismatch", code: "INVALID" }] } };
      }
      fake.fileSize += 1; // new content; waitForFileReady only accepts READY once it changes
      return { fileUpdate: { files: [{ id: v.files[0].id, fileStatus: "UPLOADED", alt: "Red box" }], userErrors: [] } };
    case "ProductMediaIds":
      return {
        product: {
          media: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: fake.productMedia.map((id) => ({ id })) },
        },
      };
    case "VariantMedia":
      return {
        product: {
          variants: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "gid://shopify/ProductVariant/1", media: { nodes: [{ id: fake.productMedia[0] }] } }],
          },
        },
      };
    case "AttachMedia":
      fake.productMedia.push(`gid://shopify/MediaImage/${300 + fake.productMedia.length}`);
      return { productUpdate: { product: { id: PRODUCT }, userErrors: [] } };
    case "DetachOld":
      fake.productMedia = fake.productMedia.filter((id) => !v.files[0].referencesToRemove || id !== v.files[0].id);
      return { fileUpdate: { userErrors: [] } };
    case "LinkVariants":
      for (const vm of v.variantMedia) fake.variantsOn[vm.variantId] = vm.mediaIds;
      return { productVariantAppendMedia: { userErrors: [] } };
    case "Reorder":
      return { productReorderMedia: { job: { id: "gid://shopify/Job/1" }, mediaUserErrors: [] } };
    default:
      throw new Error(`Unmocked Shopify operation ${op}`);
  }
}

let agent: MockAgent;
let previous: Dispatcher;

async function runQueued(kind: ItemTask["kind"]) {
  const tasks = (await itemsQueue().getJobs(["waiting", "prioritized"])).filter((t) => t.data.kind === kind);
  for (const t of tasks) {
    try {
      await runItemTask(t.data);
    } catch (error) {
      await markItemFailed(t.data, error);
      throw error;
    } finally {
      await t.remove();
      await afterItemTask(t.data);
    }
  }
  return tasks.length;
}

const requireGpu = process.env.REQUIRE_GPU_E2E === "1";

describe.runIf(!gpuUp && requireGpu)("pipeline end to end: image service required", () => {
  it(`reaches the image service at ${GPU_URL}`, () => {
    expect.fail(`REQUIRE_GPU_E2E=1, but the image service at ${GPU_URL} didn't answer /healthz. Start it (see the top of this file).`);
  });
});

describe.skipIf(!gpuUp)("pipeline end to end (GPU service at " + GPU_URL + ")", () => {
  let shopId: string;

  beforeAll(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect(/localhost|127\.0\.0\.1/);
    setGlobalDispatcher(agent);
    const json = { headers: { "content-type": "application/json" } };
    agent
      .get(`https://${SHOP}`)
      .intercept({ path: /\/admin\/api\/2026-07\/graphql\.json/, method: "POST" })
      .reply((opts) => ({ statusCode: 200, data: { data: graphql(JSON.parse(String(opts.body))) }, responseOptions: json }))
      .persist();
    agent
      .get("https://cdn.test")
      .intercept({ path: "/original.png", method: "GET" })
      .reply(200, ORIGINAL, { headers: { "content-type": "image/png" } })
      .persist();
    agent
      .get("https://upload.test")
      .intercept({ path: "/stage", method: "POST" })
      .reply((opts) => {
        // Record the size of the uploaded file part (Shopify's staged storage takes multipart POSTs).
        const file = (opts.body as unknown as FormData).get("file") as Blob;
        fake.staged.push(file.size);
        return { statusCode: 201, data: "" };
      })
      .persist();
  });

  beforeEach(async () => {
    await resetState();
    Object.assign(fake, {
      ops: [],
      fileUpdateRejects: false,
      staged: [],
      fileSize: ORIGINAL.length,
      productMedia: [MEDIA],
      variantsOn: {},
    });
    const shop = await makeShop(SHOP, 25);
    shopId = shop.id;
    await prisma.session.create({
      data: { id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false, accessToken: "shpat_test", scope: "write_products,write_files" },
    });
  });

  afterAll(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
    await deletePrefix(keys.shopPrefix(shopId));
    await itemsQueue().close();
    await jobsQueue().close();
    await redis().quit();
    await prisma.$disconnect();
  });

  async function processOneImage() {
    const job = await createJob(shopId, { imageScope: "first" }, DEFAULT_PRESET);
    await readJob(job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("estimated");

    await startJob(shopId, job.id);
    expect(await runQueued("process")).toBe(1);
    const item = await prisma.jobItem.findFirstOrThrow({ where: { jobId: job.id } });
    return { job, item };
  }

  it("reads, backs up, processes, applies in place and restores", async () => {
    const { job, item } = await processOneImage();

    expect(item.status === "ready" || item.status === "flagged").toBe(true);
    // The final status the service reports (when it reports one) decides the item status.
    const record = item.processing as unknown as ProcessingRecord;
    expect(item.status).toBe(resultStatus(item.flags as unknown as GpuFlag[], record).status);
    if (record.final_status === "NEEDS_REVIEW") expect((item.flags as unknown[]).length).toBeGreaterThan(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("review");

    // Backup is byte-identical to the original, and hashed on the way in.
    expect((await getObjectBuffer(item.backupKey!)).equals(ORIGINAL)).toBe(true);
    expect(item.sourceSha256).toBe(createHash("sha256").update(ORIGINAL).digest("hex"));
    expect(item.resultKey).toMatch(/^[0-9a-f]{64}$/);
    // Processing finished: one in-app notification linking to the job.
    expect(await listUnreadNotifications(shopId)).toMatchObject([
      { kind: "job_processed", title: "1 product image is ready.", url: `/app/jobs/${job.id}` },
    ]);
    // Output keeps the original's format (PNG) so fileUpdate can replace in place.
    expect(item.outputFormat).toBe("png");
    const output = await getObjectBuffer(item.outputKey!);
    expect(output.subarray(1, 4).toString()).toBe("PNG");
    const size = pngSize(output);
    expect(size.width).toBe(size.height); // 1:1 canvas
    expect(size.width).toBeLessThanOrEqual(2048);
    for (const k of [item.previewKey!, item.beforeKey!, item.maskKey!]) expect(await headObject(k)).not.toBeNull();
    expect(item.creditsReserved).toBe(1);
    // How it was made is stored for cost/quality monitoring (classic backend: no paid calls).
    expect(item.processing).toMatchObject({
      method: expect.any(String),
      replicate_used: false,
      replicate_calls: 0,
      estimated_cost_usd: 0,
      duration_ms: expect.any(Number),
      operations: expect.arrayContaining(["decode", "background_removal", "canvas", "export"]),
    });

    // Approve + apply.
    await decideItems(shopId, job.id, [item.id], "approve");
    await applyApproved(shopId, job.id);
    expect(await runQueued("apply")).toBe(1);

    const applied = await prisma.jobItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(applied.status).toBe("applied");
    expect(applied.appliedMediaId).toBeNull(); // replaced in place, same media id
    expect(applied.creditsCharged).toBe(1);
    expect(await getCreditSummary(shopId)).toEqual({ balance: 24, reserved: 0, available: 24 });
    expect(fake.ops).toEqual(expect.arrayContaining(["StageUpload", "ReplaceFile"]));
    expect(fake.staged).toEqual([output.length]); // the processed output was uploaded
    expect(fake.ops).not.toContain("AttachMedia");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
    expect((await listUnreadNotifications(shopId))[0]).toMatchObject({ title: "1 image was updated in your store." });

    // Restore is free and puts the original bytes back.
    fake.staged = [];
    await restoreItems(shopId, job.id, [item.id]);
    expect(await runQueued("restore")).toBe(1);
    const restored = await prisma.jobItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(restored.status).toBe("restored");
    expect(fake.staged).toEqual([ORIGINAL.length]); // the original bytes went back
    expect((await getCreditSummary(shopId)).balance).toBe(24);
  });

  it("retries an image with the stronger model (force_escalation) through the real image service", async () => {
    const { job, item } = await processOneImage();
    expect(await retryStronger(shopId, job.id, [item.id])).toMatchObject({ retried: 1, status: "processing" });
    expect(await runQueued("process")).toBe(1);
    const again = await prisma.jobItem.findUniqueOrThrow({ where: { id: item.id } });
    // The service accepted force_escalation and made a result.
    expect(["ready", "flagged", "unchanged"]).toContain(again.status);
    expect(again.forceEscalation).toBe(true);
    // New files of its own; the earlier result's files are kept (another item may share them).
    expect(again.outputKey).not.toBe(item.outputKey);
    expect(await headObject(again.outputKey!)).not.toBeNull();
    expect(await headObject(item.outputKey!)).not.toBeNull();
    const record = again.processing as unknown as ProcessingRecord;
    expect(record.superseded_runs).toEqual([
      expect.objectContaining({ method: (item.processing as unknown as ProcessingRecord).method }),
    ]);
    // The test service has no escalation backend: a service that knows force_escalation falls
    // back to local and says so.
    if (Array.isArray(record.reason_codes)) expect(record.reason_codes).toContain("ESCALATION_UNAVAILABLE");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("review");
    expect((await getCreditSummary(shopId)).balance).toBe(25); // nothing charged
  });

  it("falls back to attach-new + relink + reorder when fileUpdate is rejected", async () => {
    const { job, item } = await processOneImage();
    fake.fileUpdateRejects = true;
    await decideItems(shopId, job.id, [item.id], "approve");
    await applyApproved(shopId, job.id);
    await runQueued("apply");

    const applied = await prisma.jobItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(applied.status).toBe("applied");
    expect(applied.appliedMediaId).toMatch(/^gid:\/\/shopify\/MediaImage\/3\d\d$/);
    expect(fake.ops).toEqual(
      expect.arrayContaining(["ReplaceFile", "AttachMedia", "DetachOld", "LinkVariants", "Reorder"]),
    );
    expect(fake.variantsOn["gid://shopify/ProductVariant/1"]).toEqual([applied.appliedMediaId]);
    expect(fake.productMedia).toEqual([applied.appliedMediaId]);
  });

  it("refuses to apply when the backup is missing, and charges nothing", async () => {
    const { job, item } = await processOneImage();
    await prisma.jobItem.update({ where: { id: item.id }, data: { backupKey: `${item.backupKey}.gone` } });
    await decideItems(shopId, job.id, [item.id], "approve");
    await applyApproved(shopId, job.id);
    await expect(runQueued("apply")).rejects.toThrow(/No backup/);
    const failed = await prisma.jobItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("apply_backup_missing");
    expect(fake.ops).not.toContain("ReplaceFile");
    expect((await getCreditSummary(shopId)).balance).toBe(25);
  });
});
