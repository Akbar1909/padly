import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireShop } from "../lib/app-context.server";
import { BRAND } from "../lib/brand";
import { getCreditSummary } from "../lib/credits.server";
import { activeJobBanner, JOB_LIST_FIELDS, jobListRow, num } from "../lib/format";
import { itemCountsByJob } from "../lib/jobs.server";
import { listUnreadNotifications, markNotificationRead } from "../lib/notifications.server";
import { CreditStats } from "../components/CreditStats";
import { HelpFooter } from "../components/HelpFooter";
import { JobsTable } from "../components/JobsTable";
import {
  DISMISS_ALL_NOTIFICATIONS,
  DISMISS_NOTIFICATION,
  NotificationBanners,
} from "../components/NotificationBanners";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

/** Running jobs shown as banners; more than this is rare (the pump works one job at a time). */
const ACTIVE_BANNERS = 3;
/** Unread notifications shown as banners (Home and Jobs). */
const NOTIFICATION_BANNERS = 5;
/** Ids one "Dismiss all" may send; the page shows NOTIFICATION_BANNERS of them. */
const MAX_DISMISS_IDS = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [credits, recent, active, needsReview, notifications] = await Promise.all([
    getCreditSummary(shop.id),
    prisma.job.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: JOB_LIST_FIELDS,
    }),
    // Oldest first: that's the order the pump serves them in.
    prisma.job.findMany({
      where: { shopId: shop.id, status: { in: ["processing", "applying"] } },
      orderBy: { createdAt: "asc" },
      take: ACTIVE_BANNERS,
      select: JOB_LIST_FIELDS,
    }),
    prisma.job.count({ where: { shopId: shop.id, status: "review" } }),
    listUnreadNotifications(shop.id, NOTIFICATION_BANNERS),
  ]);
  // Live counts for every job on the page in one query.
  const counts = await itemCountsByJob([...new Set([...recent, ...active].map((j) => j.id))]);
  const countsOf = (id: string) => counts.get(id) ?? {};
  // First run: say how many free credits the install came with (none if it didn't grant any).
  const freeGrant = recent.length
    ? null
    : await prisma.creditLedger.findFirst({ where: { shopId: shop.id, reason: "free_grant" }, select: { delta: true } });
  return {
    credits,
    jobs: recent.map((j) => jobListRow(j, countsOf(j.id))),
    active: active.map((j, i) => {
      const c = countsOf(j.id);
      return {
        ...activeJobBanner(j, c),
        // The pump serves the oldest job first; a later one waits until it's done.
        waiting: i > 0 && j.status === "processing" && !(c.processing ?? 0) && (c.queued ?? 0) > 0,
      };
    }),
    needsReview,
    notifications: notifications.map((n) => ({
      id: n.id,
      kind: n.kind,
      tone: n.tone,
      title: n.title,
      body: n.body,
      url: n.url,
    })),
    freeCredits: freeGrant?.delta ?? 0,
  };
};

/** Dismissing notifications (NotificationBanners posts here from any page). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === DISMISS_NOTIFICATION) {
      await markNotificationRead(shop.id, String(form.get("notificationId") ?? ""));
      return { ok: true };
    }
    if (intent === DISMISS_ALL_NOTIFICATIONS) {
      // Only the banners the merchant saw (NotificationBanners sends their ids): one that
      // arrived after the page loaded, or one past the few shown, stays unread.
      const ids = [...new Set(form.getAll("notificationId").map(String).filter(Boolean))].slice(0, MAX_DISMISS_IDS);
      if (ids.length) {
        await prisma.notification.updateMany({
          where: { shopId: shop.id, id: { in: ids }, readAt: null },
          data: { readAt: new Date() },
        });
      }
      return { ok: true };
    }
    return { error: "Unknown action" };
  } catch (error) {
    console.error(`[notifications] ${intent} failed for shop ${shop.id}:`, error);
    return { error: "Something went wrong. Please try again in a moment." };
  }
};

export default function Index() {
  const { credits, jobs, active, needsReview, notifications, freeCredits } = useLoaderData<typeof loader>();

  return (
    <s-page heading={BRAND.name}>
      <s-button slot="primary-action" variant="primary" href="/app/jobs/new">
        New job
      </s-button>

      <NotificationBanners notifications={notifications} />

      {active.map((job) => (
        <s-banner key={job.id} tone="info" heading={job.heading}>
          {job.name}: {job.summary}.{job.waiting ? " Waiting for your earlier job to finish." : ""} We&apos;ll let
          you know here when it&apos;s done.
          <s-button slot="secondary-actions" href={`/app/jobs/${job.id}`}>
            View progress
          </s-button>
        </s-banner>
      ))}

      {jobs.length === 0 && (
        <s-banner tone="info" heading={freeCredits > 0 ? `Start with ${num(freeCredits)} free credits` : "Get started"}>
          Pick products → review previews → apply. Nothing changes on your store until you approve.
          <s-button slot="secondary-actions" href="/app/jobs/new">
            Pick products
          </s-button>
        </s-banner>
      )}

      {needsReview > 0 && (
        <s-banner tone="warning" heading={`${needsReview} job${needsReview > 1 ? "s" : ""} waiting for your review`}>
          Nothing changes in your store until you approve and apply.{" "}
          <s-link href="/app/jobs">Open jobs</s-link>
        </s-banner>
      )}

      <s-section heading="Credits">
        <s-stack direction="block" gap="base">
          <CreditStats credits={credits} />
          <s-paragraph>
            1 credit per applied image, 2 with AI upscaling. You&apos;re only charged when an image is applied to
            your store. <s-link href="/app/billing">Buy credits</s-link>
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Recent jobs">
        {jobs.length ? (
          <JobsTable jobs={jobs} />
        ) : (
          <s-paragraph>
            No jobs yet. <s-link href="/app/jobs/new">Pick some products</s-link> to see a preview. Nothing is
            charged or changed until you approve.
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-ordered-list>
          <s-list-item>Pick products by collection, vendor, type or tag.</s-list-item>
          <s-list-item>We back up every original, then clean, pad and centre each image.</s-list-item>
          <s-list-item>Review before/after previews. Flagged images always need a look.</s-list-item>
          <s-list-item>Apply: images are replaced in place, keeping alt text, order and variant links.</s-list-item>
          <s-list-item>
            Changed your mind? Restore any original for free. Restoring doesn&apos;t return the credits used.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <HelpFooter />
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
