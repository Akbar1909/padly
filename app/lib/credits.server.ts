import type {
  JobItemStatus,
  JobStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import prisma from "../db.server";
import { env } from "./env.server";

/**
 * Credit model
 * - CreditLedger holds real movements only (free grant, purchases, charges on
 *   apply). Rows are never edited; Shop.creditBalance caches their sum.
 * - A reservation is JobItem.creditsReserved on an item that is still in
 *   play inside an active job. Nothing is written to release it: rejecting,
 *   failing, or finishing the job simply takes the item out of the sum.
 * - available = balance − reserved.
 */

export const RESERVING_JOB_STATUSES: JobStatus[] = [
  "processing",
  "review",
  "applying",
];
export const RESERVING_ITEM_STATUSES: JobItemStatus[] = [
  "queued",
  "processing",
  "ready",
  "flagged",
  "approved",
  "applying",
];

type Db = PrismaClient | Prisma.TransactionClient;

export interface CreditSummary {
  balance: number;
  reserved: number;
  available: number;
}

export async function reservedCredits(db: Db, shopId: string): Promise<number> {
  const agg = await db.jobItem.aggregate({
    _sum: { creditsReserved: true },
    where: {
      shopId,
      status: { in: RESERVING_ITEM_STATUSES },
      job: { status: { in: RESERVING_JOB_STATUSES } },
    },
  });
  return agg._sum.creditsReserved ?? 0;
}

export async function getCreditSummary(
  shopId: string,
  db: Db = prisma,
): Promise<CreditSummary> {
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { creditBalance: true },
  });
  const reserved = await reservedCredits(db, shopId);
  return {
    balance: shop.creditBalance,
    reserved,
    available: shop.creditBalance - reserved,
  };
}

/** Serialise credit changes for one shop inside a transaction. */
export async function lockShop(
  tx: Prisma.TransactionClient,
  shopId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`;
}

export interface LedgerEntry {
  shopId: string;
  delta: number;
  reason: "free_grant" | "purchase" | "apply" | "adjustment";
  idempotencyKey: string;
  jobItemId?: string;
  purchaseId?: string;
  note?: string;
}

/**
 * Insert a ledger row and move the cached balance. Returns false when the
 * idempotency key was already recorded. Call with the shop locked.
 */
export async function recordLedger(
  tx: Prisma.TransactionClient,
  entry: LedgerEntry,
): Promise<boolean> {
  const existing = await tx.creditLedger.findUnique({
    where: { idempotencyKey: entry.idempotencyKey },
    select: { id: true },
  });
  if (existing) return false;
  await tx.creditLedger.create({ data: entry });
  await tx.shop.update({
    where: { id: entry.shopId },
    data: { creditBalance: { increment: entry.delta } },
  });
  return true;
}

/** Give the free tier once per shop, ever (reinstalls don't get it again). */
export async function grantFreeCredits(shopId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockShop(tx, shopId);
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
    if (shop.freeCreditsGranted) return;
    await recordLedger(tx, {
      shopId,
      delta: env().FREE_CREDITS,
      reason: "free_grant",
      idempotencyKey: `free:${shopId}`,
      note: "Free credits on install",
    });
    await tx.shop.update({
      where: { id: shopId },
      data: { freeCreditsGranted: true },
    });
  });
}

export class InsufficientCreditsError extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(
      `This job needs ${needed} credits but only ${available} are available.`,
    );
    this.name = "InsufficientCreditsError";
  }
}
