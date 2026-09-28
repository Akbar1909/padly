import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { grantFreeCredits } from "./credits.server";
import { DEFAULT_PRESET } from "./presets";

/**
 * Create the Shop row (plus default preset and free credits) on first install,
 * and clear `uninstalledAt` on reinstall. Safe to call on every request.
 */
export async function ensureShop(domain: string): Promise<Shop> {
  let shop = await prisma.shop.findUnique({ where: { domain } });

  if (!shop) {
    shop = await prisma.shop.upsert({
      where: { domain },
      create: { domain },
      update: {},
    });
  } else if (shop.uninstalledAt) {
    shop = await prisma.shop.update({
      where: { id: shop.id },
      data: { uninstalledAt: null, installedAt: new Date() },
    });
  }

  const hasPreset = await prisma.preset.count({ where: { shopId: shop.id } });
  if (!hasPreset) {
    await prisma.preset.create({
      data: { shopId: shop.id, name: "Clean & match", isDefault: true, ...DEFAULT_PRESET },
    });
  }

  if (!shop.freeCreditsGranted) {
    await grantFreeCredits(shop.id);
    shop = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
  }

  return shop;
}

/**
 * Called from the afterAuth hook (install, reinstall, or a fresh token exchange).
 * Moves installedAt forward so stale app/uninstalled retries are ignored, and
 * cancels any pending redaction because the merchant is back.
 */
export async function recordInstall(domain: string): Promise<Shop> {
  const shop = await ensureShop(domain);
  return prisma.shop.update({
    where: { id: shop.id },
    data: { installedAt: new Date(), uninstalledAt: null, redactRequestedAt: null },
  });
}

/**
 * The app is gone from the store (app/uninstalled, or Shopify refusing our
 * token): stop work in progress and start the retention clock. Stored images
 * stay until shop/redact or the retention sweep, so a quick reinstall can
 * still restore. Safe to replay. With `ifInstalledAt`, does nothing (returns
 * false) if the shop re-authenticated since that value was read.
 */
export async function markUninstalled(shopId: string, at: Date, ifInstalledAt?: Date): Promise<boolean> {
  const marked = await prisma.shop.updateMany({
    where: { id: shopId, uninstalledAt: null, ...(ifInstalledAt ? { installedAt: ifInstalledAt } : {}) },
    data: { uninstalledAt: at },
  });
  if (ifInstalledAt && !marked.count) return false;
  await prisma.job.updateMany({
    where: { shopId, status: { in: ["reading", "estimated", "processing", "applying"] } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  await prisma.jobItem.updateMany({
    where: { shopId, status: "restore_queued" },
    data: { status: "applied", error: "Restore cancelled: the app was uninstalled." },
  });
  return true;
}

export async function getShopByDomain(domain: string): Promise<Shop> {
  return (await prisma.shop.findUnique({ where: { domain } })) ?? ensureShop(domain);
}

export async function getDefaultPreset(shopId: string) {
  const preset =
    (await prisma.preset.findFirst({ where: { shopId, isDefault: true } })) ??
    (await prisma.preset.findFirst({ where: { shopId }, orderBy: { createdAt: "asc" } }));
  if (!preset) {
    return prisma.preset.create({
      data: { shopId, name: "Clean & match", isDefault: true, ...DEFAULT_PRESET },
    });
  }
  return preset;
}
