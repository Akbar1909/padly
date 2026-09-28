import type { JobItemStatus, JobStatus } from "@prisma/client";
import prisma from "../../app/db.server";
import { lockShop, recordLedger } from "../../app/lib/credits.server";
import { DEFAULT_PRESET, type PresetSettings } from "../../app/lib/presets";
import { itemsQueue, jobsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { ensureShop } from "../../app/lib/shops.server";

export async function resetState() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Notification", "CreditLedger", "Purchase", "JobItem", "Job", "Preset", "Shop", "Session" CASCADE`,
  );
  await itemsQueue().obliterate({ force: true });
  await jobsQueue().obliterate({ force: true });
  await redis().flushdb();
}

/** A shop with an exact balance (free grant adjusted away). */
export async function makeShop(domain = "test-shop.myshopify.com", balance = 25) {
  const shop = await ensureShop(domain);
  const delta = balance - shop.creditBalance;
  if (delta) {
    await prisma.$transaction(async (tx) => {
      await lockShop(tx, shop.id);
      await recordLedger(tx, {
        shopId: shop.id,
        delta,
        reason: "adjustment",
        idempotencyKey: `test-adjust:${shop.id}:${Date.now()}:${Math.random()}`,
      });
    });
  }
  return prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
}

export interface ItemSpec {
  status?: JobItemStatus;
  eligible?: boolean;
  flags?: Array<{ code: string; severity: string; message: string }>;
  reserved?: number;
  outputKey?: string;
  backupKey?: string;
  upscaleApplied?: boolean;
  excluded?: boolean;
  /** Defaults to a media id unique to the job. */
  mediaId?: string;
  error?: string;
  errorCode?: string;
}

export async function makeJob(
  shopId: string,
  specs: ItemSpec[],
  status: JobStatus = "estimated",
  preset: PresetSettings = DEFAULT_PRESET,
) {
  const job = await prisma.job.create({
    data: {
      shopId,
      status,
      filter: { imageScope: "first" },
      presetSnapshot: preset,
      total: specs.length,
    },
  });
  await prisma.jobItem.createMany({
    data: specs.map((s, i) => ({
      jobId: job.id,
      shopId,
      productId: `gid://shopify/Product/${i + 1}`,
      productTitle: `Product ${i + 1}`,
      mediaId: s.mediaId ?? `gid://shopify/MediaImage/${job.id.slice(-6)}${i + 1}`,
      position: 0,
      originalUrl: `https://cdn.example.com/${i}.jpg`,
      mimeType: "image/jpeg",
      width: 800,
      height: 800,
      status: s.status ?? "queued",
      upscaleEligible: s.eligible ?? false,
      upscaleApplied: s.upscaleApplied ?? false,
      excluded: s.excluded ?? false,
      flags: s.flags ?? [],
      creditsReserved: s.reserved ?? 0,
      outputKey: s.outputKey,
      backupKey: s.backupKey,
      error: s.error,
      errorCode: s.errorCode,
    })),
  });
  const items = await prisma.jobItem.findMany({ where: { jobId: job.id }, orderBy: { productId: "asc" } });
  return { job, items };
}

export const flag = (code: string) => ({ code, severity: "warning", message: code });

export async function statusesOf(jobId: string) {
  const items = await prisma.jobItem.findMany({ where: { jobId }, orderBy: { productId: "asc" } });
  return items.map((i) => i.status);
}

/** Move rows' updatedAt into the past (Prisma always stamps now() on its own updates). */
export async function ageRows(table: "Job" | "JobItem", ids: string[], ms: number) {
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "updatedAt" = now() - ($1::int * interval '1 millisecond') WHERE "id" = ANY($2::text[])`,
    ms,
    ids,
  );
}

/** Capture JSON log lines written while `fn` runs. */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: Array<Record<string, unknown>> }> {
  const lines: Array<Record<string, unknown>> = [];
  const grab = (...args: unknown[]) => {
    try {
      const parsed = JSON.parse(String(args[0]));
      if (parsed && typeof parsed === "object") lines.push(parsed);
    } catch {
      // not a JSON log line
    }
  };
  const log = console.log;
  const error = console.error;
  console.log = grab;
  console.error = grab;
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
}
