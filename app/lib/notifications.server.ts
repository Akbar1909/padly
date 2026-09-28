import type { Job, Notification, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { env } from "./env.server";
import { errorMessage } from "./errors";
import { describeFilter, filterForClient } from "./filters";
import { log } from "./log.server";
import {
  appliedCopy,
  needsCreditsCopy,
  processedCopy,
  type NotificationCopy,
} from "./notifications";
import { enqueueJobTask } from "./queue.server";

/**
 * In-app notifications: one row per event (dedupeKey), created exactly once however often the
 * code path runs (createMany + skipDuplicates on a unique key). The rows hold no personal data
 * and are deleted with the shop or the job.
 */

// ─── Email (interface only) ─────────────────────────────────────────────────

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Providers that support it should drop a second send with the same key. */
  idempotencyKey: string;
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * Email providers by EMAIL_PROVIDER value. None is implemented: until one is registered here
 * (and the privacy policy says so, since the shop's email would be used), nothing is emailed,
 * no email address is stored, and the Settings toggle stays hidden.
 */
const EMAIL_PROVIDERS: Record<string, () => EmailSender> = {};

let warnedUnknownProvider = false;

/** The configured email sender, or null (always null today). */
export function emailSender(): EmailSender | null {
  const name = env().EMAIL_PROVIDER;
  if (!name) return null;
  const make = EMAIL_PROVIDERS[name];
  if (!make) {
    if (!warnedUnknownProvider) {
      log.warn("EMAIL_PROVIDER is set but no such provider exists; emails are off", { provider: name });
      warnedUnknownProvider = true;
    }
    return null;
  }
  return make();
}

/** Show the "Email me when a job finishes" toggle only when this is true. */
export function emailNotificationsAvailable(): boolean {
  return emailSender() !== null;
}

/** Shop.settings.notifyEmail (default false). */
export function notifyEmailEnabled(settings: unknown): boolean {
  return (settings as { notifyEmail?: unknown } | null)?.notifyEmail === true;
}

export async function setNotifyEmail(shopId: string, enabled: boolean): Promise<void> {
  // Merge into the JSON in one statement so other settings are never lost to a race.
  await prisma.$executeRaw`
    UPDATE "Shop"
    SET "settings" = COALESCE("settings", '{}'::jsonb) || jsonb_build_object('notifyEmail', ${enabled}::boolean),
        "updatedAt" = now()
    WHERE "id" = ${shopId}`;
}

async function queueEmail(shopId: string, dedupeKey: string): Promise<void> {
  if (!emailSender()) return;
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { settings: true } });
  if (!notifyEmailEnabled(shop?.settings)) return;
  const row = await prisma.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (!row) return;
  await enqueueJobTask({ name: "notify-email", notificationId: row.id }, { jobId: `notify-email-${row.id}` });
}

// ─── Creating ───────────────────────────────────────────────────────────────

export interface NotificationInput {
  shopId: string;
  jobId?: string | null;
  dedupeKey: string;
  copy: NotificationCopy;
  body?: string | null;
}

/**
 * Insert once per dedupeKey, in the caller's transaction when one is given (so the row commits
 * with the state change it reports). Returns true when this call created it. Call
 * notificationCreated after the commit.
 */
export async function insertNotification(
  db: Prisma.TransactionClient | typeof prisma,
  input: NotificationInput,
): Promise<boolean> {
  const { count } = await db.notification.createMany({
    data: [
      {
        shopId: input.shopId,
        jobId: input.jobId ?? null,
        kind: input.copy.kind,
        tone: input.copy.tone,
        title: input.copy.title,
        body: input.body ?? null,
        url: input.copy.url,
        dedupeKey: input.dedupeKey,
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}

/** Insert once per dedupeKey. Returns true when this call created it. */
export async function createNotification(input: NotificationInput): Promise<boolean> {
  if (!(await insertNotification(prisma, input))) return false;
  await notificationCreated(input);
  return true;
}

/** A notification row was committed: log it and queue its email (never throws). */
export async function notificationCreated(input: NotificationInput): Promise<void> {
  log.info("NOTIFICATION_CREATED", {
    shopId: input.shopId,
    jobId: input.jobId,
    kind: input.copy.kind,
    tone: input.copy.tone,
    dedupeKey: input.dedupeKey,
  });
  try {
    await queueEmail(input.shopId, input.dedupeKey);
  } catch (error) {
    log.warn("notification email not queued", { dedupeKey: input.dedupeKey, error: errorMessage(error) });
  }
}

type NotifyJob = Pick<Job, "id" | "shopId" | "filter" | "phaseStartedAt" | "startedAt">;

const selectionOf = (job: Pick<Job, "filter">) => describeFilter(filterForClient(job.filter));

/**
 * The notification for a processing or applying phase that ended, or null when there is none
 * to send. The dedupeKey (job, phase, phase start) makes a repeat a no-op. An apply round
 * without a phase snapshot (started before phases were recorded) isn't reported: its counts
 * would be every image the job ever processed, not the ones this round wrote.
 */
export function phaseEndedNotification(
  job: NotifyJob,
  phase: "processing" | "applying",
  counts: { completed: number; failed: number },
): NotificationInput | null {
  if (phase === "applying" && !job.phaseStartedAt) return null;
  const copy =
    phase === "processing"
      ? processedCopy(job.id, counts.completed, counts.failed)
      : appliedCopy(job.id, counts.completed, counts.failed);
  if (!copy) return null;
  const phaseStart = (job.phaseStartedAt ?? job.startedAt)?.getTime() ?? 0;
  return {
    shopId: job.shopId,
    jobId: job.id,
    dedupeKey: `${job.id}:${phase === "processing" ? "processed" : "applied"}:${phaseStart}`,
    copy,
    body: selectionOf(job),
  };
}

/**
 * A processing or applying phase ended (outside a transaction). refreshJobState inserts the
 * same row inside the transaction that ends the phase instead, so it is never lost.
 */
export async function notifyJobPhaseEnded(
  job: NotifyJob,
  phase: "processing" | "applying",
  counts: { completed: number; failed: number },
): Promise<boolean> {
  const input = phaseEndedNotification(job, phase, counts);
  return input ? createNotification(input) : false;
}

/** An auto-started job is waiting in "estimated" because the shop is short of credits. */
export async function notifyNeedsCredits(job: Pick<Job, "id" | "shopId" | "filter">, images: number): Promise<boolean> {
  return createNotification({
    shopId: job.shopId,
    jobId: job.id,
    dedupeKey: `${job.id}:needs_credits`,
    copy: needsCreditsCopy(job.id, images),
    body: selectionOf(job),
  });
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type NotificationRow = Pick<Notification, "id" | "jobId" | "kind" | "tone" | "title" | "body" | "url" | "createdAt">;

const ROW_SELECT = {
  id: true,
  jobId: true,
  kind: true,
  tone: true,
  title: true,
  body: true,
  url: true,
  createdAt: true,
} as const;

/** Newest unread notifications for the Home and Jobs banners. */
export async function listUnreadNotifications(shopId: string, take = 5): Promise<NotificationRow[]> {
  return prisma.notification.findMany({
    where: { shopId, readAt: null },
    orderBy: { createdAt: "desc" },
    take,
    select: ROW_SELECT,
  });
}

/** Dismiss one notification. Scoped by shop; returns 0 when it wasn't this shop's or was already read. */
export async function markNotificationRead(shopId: string, notificationId: string): Promise<number> {
  const r = await prisma.notification.updateMany({
    where: { id: notificationId, shopId, readAt: null },
    data: { readAt: new Date() },
  });
  return r.count;
}

/** Opening a job page reads its notifications. */
export async function markJobNotificationsRead(shopId: string, jobId: string): Promise<number> {
  const r = await prisma.notification.updateMany({
    where: { shopId, jobId, readAt: null },
    data: { readAt: new Date() },
  });
  return r.count;
}

export async function markAllNotificationsRead(shopId: string): Promise<number> {
  const r = await prisma.notification.updateMany({ where: { shopId, readAt: null }, data: { readAt: new Date() } });
  return r.count;
}
