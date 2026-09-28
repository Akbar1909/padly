import { timingSafeEqual, createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { env } from "./env.server";
import { summarizeProcessing, type ProcessingSummary, type SummaryRow } from "./processing";

/**
 * The processing cost dashboard's data: what the ops report (`npm run report:processing`,
 * worker/report.ts) prints and GET /internal/metrics answers, from the processing record
 * stored on each item (app/lib/processing.ts).
 */

export interface MetricsRow extends SummaryRow {
  jobId: string;
  updatedAt: Date;
}

export interface MetricsFilter {
  since: Date;
  /** A shop's myshopify domain. */
  shopDomain?: string;
  jobId?: string;
}

/**
 * Items changed since `since` (optionally one shop's or one job's), newest first, with what the
 * summaries need. The per-check measurements (quality_checks) are left in the database: the
 * summaries don't read them, and they are most of a record's size.
 */
export async function loadProcessingRows(filter: MetricsFilter): Promise<MetricsRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{ jobId: string; status: string; flags: unknown; hasOutput: boolean; updatedAt: Date; processing: unknown }>
  >`
    SELECT i."jobId", i."status"::text AS "status", i."flags", (i."outputKey" IS NOT NULL) AS "hasOutput",
           i."updatedAt", (i."processing" - 'quality_checks') AS "processing"
    FROM "JobItem" i
    ${filter.shopDomain ? Prisma.sql`JOIN "Shop" s ON s."id" = i."shopId" AND s."domain" = ${filter.shopDomain}` : Prisma.empty}
    WHERE i."updatedAt" >= ${filter.since}
      ${filter.jobId ? Prisma.sql`AND i."jobId" = ${filter.jobId}` : Prisma.empty}
    ORDER BY i."updatedAt" DESC`;
  return rows.map((r) => ({
    jobId: r.jobId,
    status: r.status,
    flags: r.flags,
    // Only whether there is one matters (a failed item with an output failed while applying).
    outputKey: r.hasOutput ? "stored" : null,
    updatedAt: r.updatedAt,
    processing: r.processing,
  }));
}

/** summarizeProcessing with the configured fallback for the average paid cut-out cost. */
export function summarize(rows: SummaryRow[]): ProcessingSummary {
  return summarizeProcessing(rows, { fallbackCutoutUsd: env().REPLICATE_AVG_CUTOUT_USD });
}

/** Rows grouped by UTC day (YYYY-MM-DD), newest first. */
export function groupByDay<T extends { updatedAt: Date }>(rows: T[]): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const row of rows) {
    const day = row.updatedAt.toISOString().slice(0, 10);
    const list = byDay.get(day);
    if (list) list.push(row);
    else byDay.set(day, [row]);
  }
  return byDay;
}

export const METRICS_MAX_DAYS = 90;

export interface ProcessingMetrics {
  since: string;
  days: number;
  generatedAt: string;
  overall: ProcessingSummary;
  byDay: Array<{ day: string } & ProcessingSummary>;
}

/** The dashboard for the last `days` days (every shop). */
export async function processingMetrics(days: number, now: number = Date.now()): Promise<ProcessingMetrics> {
  const since = new Date(now - days * 86_400_000);
  const rows = await loadProcessingRows({ since });
  return {
    since: since.toISOString(),
    days,
    generatedAt: new Date(now).toISOString(),
    overall: summarize(rows),
    byDay: [...groupByDay(rows)].map(([day, dayRows]) => ({ day, ...summarize(dayRows) })),
  };
}

/** Constant-time comparison of a presented bearer token with the configured one. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && presented.length === expected.length;
}
