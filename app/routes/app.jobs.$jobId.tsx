import { useEffect, useMemo, useState } from "react";
import type { JobItemStatus, Prisma } from "@prisma/client";
import type { ActionFunctionArgs, ClientLoaderFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useFetcher, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { getApiJob, listApiItems, shopifyThumbnail } from "../lib/api.server";
import { requireShop } from "../lib/app-context.server";
import { getCreditSummary, InsufficientCreditsError } from "../lib/credits.server";
import { env } from "../lib/env.server";
import { describeFilter, filterForClient } from "../lib/filters";
import {
  FINAL_STATUS,
  finishedCopy,
  FLAG_HELP,
  FLAG_LABELS,
  formatDate,
  formatDay,
  ITEM_STATUS,
  jobDisplayStatus,
  jobHeading,
  num,
  phaseCopy,
  plural,
  retryMessage,
  UNCHANGED_TEXT,
  upscaleLabel,
  visibleJobNotices,
} from "../lib/format";
import {
  applyApproved,
  approveAllUnflagged,
  cancelJob,
  decideItems,
  finishJob,
  itemCounts,
  JobStateError,
  restoreItems,
  retryFailed,
  retryStronger,
  selectionEstimate,
  setIncluded,
  startJob,
} from "../lib/jobs.server";
import { markJobNotificationsRead } from "../lib/notifications.server";
import type { PresetSettings } from "../lib/presets";
import { itemFinalStatus } from "../lib/processing";
import { hasCreditsNotice } from "../lib/progress";
import { presignGet } from "../lib/storage.server";
import { BeforeAfter } from "../components/BeforeAfter";
import { ACTIVITY_QUERY, toActivity, type JobActivity } from "../components/cleaning/activity";
import { CleaningStrip } from "../components/cleaning/CleaningStrip";
import { ConfirmModal, useConfirm } from "../components/ConfirmModal";
import { HelpFooter, SupportLink } from "../components/HelpFooter";
import { FinishedPanel, LiveStatus, RunningPanel } from "../components/JobProgress";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import { KEEP_LAST_DATA, keepLastDataOnError, useKeepLastData, useLiveJob } from "../components/useLiveJob";

const PAGE_SIZE = 24;
const PICK_PAGE_SIZE = 48;

/**
 * The cleaning strip's first data (useLiveJob keeps it fresh): the images in flight and the
 * last finished. Never worth failing the page.
 */
async function loadActivity(shopId: string, jobId: string): Promise<JobActivity | null> {
  try {
    const page = await listApiItems(shopId, jobId, new URLSearchParams(ACTIVITY_QUERY));
    return page ? toActivity(page) : null;
  } catch (error) {
    console.error(`[jobs] couldn't load the cleaning strip for job ${jobId}:`, error);
    return null;
  }
}

const TABS: Array<{ id: string; label: string; statuses: JobItemStatus[] | null }> = [
  { id: "review", label: "To review", statuses: ["ready", "flagged"] },
  { id: "flagged", label: "Needs review", statuses: ["flagged"] },
  { id: "unchanged", label: "Already clean", statuses: ["unchanged"] },
  { id: "approved", label: "Approved", statuses: ["approved", "applying"] },
  { id: "rejected", label: "Kept original", statuses: ["rejected"] },
  { id: "applied", label: "Applied", statuses: ["applied", "restore_queued", "restoring", "restored"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
  { id: "all", label: "All", statuses: null },
];

const NO_SELECTION: Set<string> = new Set();

const CONFIRM_APPLY = "confirm-apply";
const CONFIRM_RESTORE_ALL = "confirm-restore-all";
const CONFIRM_CANCEL = "confirm-cancel";
const CONFIRM_FINISH = "confirm-finish";
const CONFIRM_STOP_APPLY = "confirm-stop-apply";

const ACTION_FAILED = "Something went wrong. Please try again in a moment.";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const jobId = params.jobId ?? "";
  // The live view the page polls for (GET /api/image-jobs/:jobId): its phase is the status
  // this page renders, so the poll and the page can't disagree about it.
  const [live, job] = await Promise.all([
    getApiJob(shop.id, jobId),
    prisma.job.findFirst({ where: { id: jobId, shopId: shop.id } }),
  ]);
  if (!live || !job) throw new Response("Job not found", { status: 404 });
  // Opening the job reads its notifications (Home's banners). Run after the job read: a phase
  // end commits its notification with the status change, so a load that shows the new status
  // always marks that notification read too. Never worth failing the page.
  await markJobNotificationsRead(shop.id, jobId).catch((error) =>
    console.error(`[notifications] couldn't mark job ${jobId} read:`, error),
  );
  const status = live.phase;

  const url = new URL(request.url);
  const counts = await itemCounts(job.id);
  const defaultTab = status === "done" ? "applied" : "review";
  const tab = TABS.find((t) => t.id === url.searchParams.get("tab")) ?? TABS.find((t) => t.id === defaultTab)!;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where: Prisma.JobItemWhereInput = {
    jobId: job.id,
    ...(tab.statuses ? { status: { in: tab.statuses } } : {}),
  };
  const showGrid = !["reading", "estimated"].includes(status);
  const picking = status === "estimated";
  const [rows, filtered, credits, estimate, pickRows, applyCost, activity] = await Promise.all([
    showGrid
      ? prisma.jobItem.findMany({
          where,
          orderBy: [{ productTitle: "asc" }, { position: "asc" }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        })
      : Promise.resolve([]),
    showGrid ? prisma.jobItem.count({ where }) : Promise.resolve(0),
    getCreditSummary(shop.id),
    picking ? selectionEstimate(job.id) : Promise.resolve(null),
    picking
      ? prisma.jobItem.findMany({
          where: { jobId: job.id },
          orderBy: [{ productTitle: "asc" }, { position: "asc" }, { id: "asc" }],
          skip: (page - 1) * PICK_PAGE_SIZE,
          take: PICK_PAGE_SIZE,
          select: {
            id: true,
            productTitle: true,
            width: true,
            height: true,
            thumbnailUrl: true,
            originalUrl: true,
            excluded: true,
            upscaleEligible: true,
          },
        })
      : Promise.resolve([]),
    // What "Apply" will charge: an approved item's reservation is what it costs to apply.
    status === "review"
      ? prisma.jobItem
          .aggregate({ where: { jobId: job.id, status: "approved" }, _sum: { creditsReserved: true } })
          .then((a) => a._sum.creditsReserved ?? 0)
      : Promise.resolve(0),
    status === "processing" ? loadActivity(shop.id, job.id) : Promise.resolve(null),
  ]);

  const picks = pickRows.map((r) => ({
    id: r.id,
    productTitle: r.productTitle,
    width: r.width,
    height: r.height,
    excluded: r.excluded,
    upscaleEligible: r.upscaleEligible,
    // Shopify CDN at a sensible size; null for anything else (signed URLs expire).
    thumbnail: shopifyThumbnail(r.thumbnailUrl ?? r.originalUrl),
  }));

  const items = await Promise.all(
    rows.map(async (it) => ({
      id: it.id,
      productTitle: it.productTitle,
      productId: it.productId,
      position: it.position,
      status: it.status,
      // READY / NEEDS_REVIEW / FAILED / NO_CHANGE: what the automatic checks said.
      finalStatus: itemFinalStatus(it),
      // Processed (or being processed) with "Retry with stronger model".
      strongerModel: it.forceEscalation,
      flags: (it.flags as Array<{ code: string; message: string }>) ?? [],
      width: it.width,
      height: it.height,
      outputWidth: it.outputWidth,
      outputHeight: it.outputHeight,
      upscale: upscaleLabel((it.models as { upscale?: { method?: string } } | null)?.upscale?.method ?? null),
      // Merchant-facing text: the worker keeps technical details in the logs.
      error: it.error,
      creditsCharged: it.creditsCharged,
      before: it.beforeKey ? await presignGet(it.beforeKey) : null,
      after: it.previewKey ? await presignGet(it.previewKey) : null,
      mask: it.maskKey ? await presignGet(it.maskKey) : null,
    })),
  );

  // The filter can name thousands of products: only its description goes to the browser.
  const filter = filterForClient(job.filter);
  const itemTotal = Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
  return {
    job: {
      id: job.id,
      status,
      heading: jobHeading(filter),
      selection: describeFilter(filter),
      preset: job.presetSnapshot as unknown as PresetSettings,
      autoStart: job.autoStart,
      // A failed job's reason, or the "nothing matched" notice.
      failure: status === "failed" ? (job.error ?? "We couldn't read your products from Shopify.") : null,
      noMatch: status === "done" && itemTotal === 0 ? (job.error ?? "No product images matched this selection.") : null,
      notices: visibleJobNotices(status, job.error, counts),
      // An auto-start (API job) that couldn't reserve its credits: said in the estimate's banner.
      creditsBlocked: status === "estimated" && hasCreditsNotice(job.error),
      createdAt: job.createdAt,
      // Maintenance closes reviews left untouched this long (worker/tasks/jobs.ts).
      reviewExpiresAt:
        status === "review" ? new Date(job.updatedAt.getTime() + env().REVIEW_EXPIRY_DAYS * 24 * 3600_000) : null,
    },
    live,
    activity,
    counts,
    credits,
    applyCost,
    estimate,
    items,
    picks,
    tab: tab.id,
    page,
    pages: picking
      ? Math.max(1, Math.ceil((estimate?.total ?? 0) / PICK_PAGE_SIZE))
      : Math.max(1, Math.ceil(filtered / PAGE_SIZE)),
  };
};

/**
 * The server loader, except when one of useLiveJob's automatic reloads fails on a passing
 * error (a deploy starting, a database blip): the page then keeps what it shows
 * (KEEP_LAST_DATA, useKeepLastData), as a failed poll does, instead of being replaced by the
 * error boundary. The merchant's own navigations and submissions still show errors. Not run
 * on hydration: the first render uses the server's data.
 */
export async function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
  try {
    return await serverLoader<typeof loader>();
  } catch (error) {
    if (keepLastDataOnError(request.url, error)) return KEEP_LAST_DATA;
    throw error;
  }
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const jobId = params.jobId!;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const ids = form.getAll("itemId").map(String);

  try {
    switch (intent) {
      case "start": {
        const { skipped } = await startJob(shop.id, jobId);
        // The page also keeps a notice saying which images were skipped and why.
        return {
          message: skipped
            ? `Processing started. ${plural(skipped, "image")} already in another job ${skipped === 1 ? "was" : "were"} skipped`
            : "Processing started",
        };
      }
      case "cancel":
      case "stopApply": {
        // cancelJob cancels a queued or processing job and stops an applying one. Each button
        // does only its own half, whatever the job moved on to since the click.
        const current = await prisma.job.findFirst({ where: { id: jobId, shopId: shop.id }, select: { status: true } });
        if (intent === "stopApply" && current?.status !== "applying") return { message: "Applying had already finished" };
        if (intent === "cancel" && current?.status === "applying") {
          return { error: "This job is applying images now. Reload the page to stop it." };
        }
        const status = await cancelJob(shop.id, jobId);
        return { message: status === "review" ? "Applying stopped" : "Job cancelled" };
      }
      case "include":
      case "exclude":
        // Single ticks come from per-card fetchers: no toast.
        await setIncluded(shop.id, jobId, ids, intent === "include");
        return { quiet: true };
      case "includeAll":
        await setIncluded(shop.id, jobId, "all", true);
        return { message: "All images selected" };
      case "excludeAll":
        await setIncluded(shop.id, jobId, "all", false);
        return { message: "All images deselected" };
      case "approve":
      case "reject":
      case "reset": {
        const n = await decideItems(shop.id, jobId, ids, intent);
        return { message: `${n} image${n === 1 ? "" : "s"} updated` };
      }
      case "approveAll": {
        // READY images only: never one that needs review or is already clean.
        const n = await approveAllUnflagged(shop.id, jobId);
        return { message: `${n} image${n === 1 ? "" : "s"} approved` };
      }
      case "retryStronger": {
        // The paid model first, for images in review (ready, needs review, already clean).
        const { retried, skipped } = await retryStronger(shop.id, jobId, ids);
        const busyNote = skipped
          ? `${plural(skipped, "image")} ${skipped === 1 ? "is" : "are"} in another job that hasn't finished.`
          : "";
        if (!retried) return skipped ? { error: busyNote } : { message: "Nothing to retry" };
        return {
          message: `Retrying ${plural(retried, "image")} with the stronger model${skipped ? `. ${busyNote}` : ""}`,
        };
      }
      case "apply":
        await applyApproved(shop.id, jobId);
        return { message: "Applying approved images" };
      case "finish":
        await finishJob(shop.id, jobId);
        return { message: "Job finished; unused credits released" };
      case "retry": {
        // Every failed image, or the ones sent (a card's Retry, "Retry selected"). Ones that
        // failed while applying already have their result: retrying approves them again
        // rather than reprocessing them. Counted first, for the message only.
        const reapprovable = await prisma.jobItem.count({
          where: {
            jobId,
            shopId: shop.id,
            status: "failed",
            outputKey: { not: null },
            ...(ids.length ? { id: { in: ids } } : {}),
          },
        });
        const { retried, skipped, status } = await retryFailed(shop.id, jobId, ids.length ? ids : undefined);
        const busyNote = skipped
          ? `${plural(skipped, "image")} ${skipped === 1 ? "is" : "are"} in another job that hasn't finished; retry ${
              skipped === 1 ? "it" : "them"
            } once that job is done.`
          : "";
        if (!retried) return skipped ? { error: busyNote } : { message: "Nothing left to retry" };
        return { message: `${retryMessage(retried, reapprovable, status)}${skipped ? `. ${busyNote}` : ""}` };
      }
      case "restore": {
        const n = await restoreItems(shop.id, jobId, ids);
        return { message: `Restoring ${n} image${n === 1 ? "" : "s"}` };
      }
      case "restoreAll": {
        const n = await restoreItems(shop.id, jobId);
        return { message: `Restoring ${n} image${n === 1 ? "" : "s"}` };
      }
      default:
        return { error: "Unknown action" };
    }
  } catch (error) {
    if (error instanceof InsufficientCreditsError) return { error: error.message, needsCredits: true };
    if (error instanceof JobStateError) return { error: error.message };
    // Auth responses from the Shopify library must pass through.
    if (error instanceof Response) throw error;
    console.error(`[jobs] ${intent} failed for job ${jobId}:`, error);
    return { error: ACTION_FAILED };
  }
};

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;
type Item = LoaderData["items"][number];

const creditsLabel = (n: number) => `${num(n)} credit${n === 1 ? "" : "s"}`;

function CostRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        padding: "8px 0",
        borderBottom: "1px solid #ebebeb",
        fontWeight: strong ? 650 : 450,
      }}
    >
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

type PickItem = LoaderData["picks"][number];

/** One found image in the picker. Ticking saves immediately and shows optimistically. */
function PickCard({ item, showUpscale }: { item: PickItem; showUpscale: boolean }) {
  const fetcher = useFetcher<{ error?: string }>();
  const shopify = useAppBridge();
  const pending = fetcher.formData?.get("intent");
  const error = fetcher.data?.error;
  useEffect(() => {
    if (error) shopify.toast.show(error, { isError: true });
  }, [error, shopify]);
  const included = pending ? pending === "include" : !item.excluded;
  const toggle = () =>
    fetcher.submit({ intent: included ? "exclude" : "include", itemId: item.id }, { method: "post" });

  return (
    <label
      style={{
        display: "block",
        cursor: "pointer",
        padding: 8,
        borderRadius: 10,
        background: "#fff",
        border: included ? "2px solid #303030" : "2px solid #e3e3e3",
        opacity: included ? 1 : 0.55,
        transition: "opacity 0.15s, border-color 0.15s",
      }}
    >
      <div style={{ position: "relative", aspectRatio: "1 / 1", background: "#f6f6f6", borderRadius: 6, overflow: "hidden" }}>
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt={item.productTitle}
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        ) : (
          <div style={{ height: "100%", display: "grid", placeItems: "center", color: "#616161", fontSize: 13 }}>
            No preview
          </div>
        )}
        <input
          type="checkbox"
          checked={included}
          onChange={toggle}
          aria-label={`Process ${item.productTitle || "this image"}`}
          style={{ position: "absolute", top: 8, left: 8, width: 20, height: 20, margin: 0, cursor: "pointer" }}
        />
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 13,
          fontWeight: 550,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.productTitle || "Untitled product"}
      </div>
      <div style={{ fontSize: 12, color: "#616161" }}>
        {item.width && item.height ? `${item.width}×${item.height}` : "Size unknown"}
        {showUpscale && item.upscaleEligible ? " · AI upscale" : ""}
      </div>
    </label>
  );
}

const REVIEWABLE: JobItemStatus[] = ["ready", "flagged", "unchanged", "approved", "rejected"];
/** What "Retry with stronger model" takes (retryStronger). */
const RETRY_STRONGER: JobItemStatus[] = ["ready", "flagged", "unchanged"];

/**
 * Cards with a checkbox: reviewable ones while in review, failed ones while they can be retried
 * (review or done), applied ones (restore) at any time.
 */
function isSelectable(status: JobItemStatus, canReview: boolean, canRetry: boolean): boolean {
  return (
    status === "applied" || (canReview && REVIEWABLE.includes(status)) || (canRetry && status === "failed")
  );
}

function ItemCard({
  item,
  aspectRatio,
  showMask,
  selected,
  canReview,
  canRetry,
  pending,
  onToggle,
  onAction,
}: {
  item: Item;
  aspectRatio: string;
  showMask: boolean;
  selected: boolean;
  /** Decisions are only accepted while the job is in review (decideItems). */
  canReview: boolean;
  /** Failed images can be retried once the job is in review or done (retryFailed). */
  canRetry: boolean;
  /** The intent being submitted for this card right now, if any. */
  pending: string | null;
  onToggle: () => void;
  onAction: (intent: string, ids: string[]) => void;
}) {
  const status = ITEM_STATUS[item.status] ?? { label: item.status, tone: "neutral" as const };
  const selectable = isSelectable(item.status, canReview, canRetry);
  // After a decision the badge shows the decision; the checks' verdict is shown beside it.
  const verdict =
    item.finalStatus && !["ready", "flagged", "unchanged", "failed"].includes(item.status)
      ? FINAL_STATUS[item.finalStatus]
      : null;
  const loading = (intent: string) => (pending === intent ? { loading: true } : {});
  // Screen readers hear which image a button is for, not a list of identical "Retry"s.
  const name = item.productTitle || "untitled product";
  const labelled = (action: string) => ({ accessibilityLabel: `${action}: ${name}` });
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base" background={item.status === "flagged" ? "subdued" : "base"}>
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
          <label style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0, flex: 1 }}>
            {selectable && <input type="checkbox" checked={selected} onChange={onToggle} />}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 550 }}>
              {item.productTitle || "Untitled product"}
            </span>
          </label>
          <s-badge tone={status.tone}>{status.label}</s-badge>
        </s-stack>
        {verdict && (
          <s-stack direction="inline" gap="small-200">
            <s-badge tone={verdict.tone}>{verdict.label}</s-badge>
          </s-stack>
        )}

        {item.after || item.before ? (
          <BeforeAfter
            before={item.before}
            after={item.after}
            mask={item.mask}
            showMask={showMask}
            aspectRatio={aspectRatio}
            label={item.productTitle}
          />
        ) : (
          <div
            style={{
              aspectRatio,
              borderRadius: 8,
              background: "#f6f6f6",
              display: "grid",
              placeItems: "center",
              color: "#616161",
              fontSize: 13,
            }}
          >
            {item.status === "failed" ? "No preview" : "Waiting…"}
          </div>
        )}

        {item.flags.length > 0 && (
          <s-stack direction="block" gap="small-300">
            <s-stack direction="inline" gap="small-200">
              {item.flags.map((f) => (
                <s-badge key={f.code} tone="warning">
                  {FLAG_LABELS[f.code] ?? "Flagged"}
                </s-badge>
              ))}
            </s-stack>
            {/* Visible, not a hover title: touch screens and screen readers need the reason too. */}
            {item.flags.map((f) => (
              <s-text key={f.code} color="subdued">
                {FLAG_HELP[f.code] ?? f.message}
              </s-text>
            ))}
          </s-stack>
        )}

        <s-text color="subdued">
          {item.width && item.height ? `${item.width}×${item.height}` : ""}
          {item.outputWidth && item.outputHeight ? ` → ${item.outputWidth}×${item.outputHeight}` : ""}
          {item.upscale ? ` · ${item.upscale}` : ""}
        </s-text>
        {item.status === "unchanged" && (
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">{UNCHANGED_TEXT}</s-text>
            <s-text color="subdued">{FINAL_STATUS.NO_CHANGE.help}</s-text>
          </s-stack>
        )}
        {item.strongerModel && (item.status === "queued" || item.status === "processing") && (
          <s-text color="subdued">Processing again with the stronger model…</s-text>
        )}
        {item.strongerModel && item.finalStatus && item.finalStatus !== "FAILED" && (
          <s-text color="subdued">Made with the stronger model.</s-text>
        )}
        {item.error && <s-text tone="critical">{item.error}</s-text>}

        <s-stack direction="inline" gap="small-200">
          {canReview && (item.status === "ready" || item.status === "flagged") && (
            <>
              <s-button
                variant="secondary"
                onClick={() => onAction("approve", [item.id])}
                {...labelled("Approve")}
                {...loading("approve")}
              >
                Approve
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => onAction("reject", [item.id])}
                {...labelled("Keep original")}
                {...loading("reject")}
              >
                Keep original
              </s-button>
            </>
          )}
          {canReview && RETRY_STRONGER.includes(item.status) && (
            <s-button
              variant="tertiary"
              onClick={() => onAction("retryStronger", [item.id])}
              {...labelled("Retry with stronger model")}
              {...loading("retryStronger")}
            >
              Retry with stronger model
            </s-button>
          )}
          {canReview && (item.status === "approved" || item.status === "rejected") && (
            <s-button
              variant="tertiary"
              onClick={() => onAction("reset", [item.id])}
              {...labelled("Undo")}
              {...loading("reset")}
            >
              Undo
            </s-button>
          )}
          {canRetry && item.status === "failed" && (
            <s-button
              variant="tertiary"
              onClick={() => onAction("retry", [item.id])}
              {...labelled("Retry")}
              {...loading("retry")}
            >
              Retry
            </s-button>
          )}
          {item.status === "applied" && (
            <s-button
              variant="tertiary"
              onClick={() => onAction("restore", [item.id])}
              {...labelled("Restore original")}
              {...loading("restore")}
            >
              Restore original
            </s-button>
          )}
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export default function JobPage() {
  // The last real data stays on screen when an automatic reload failed (clientLoader).
  const {
    job,
    live: loaderLive,
    activity: loaderActivity,
    counts,
    credits,
    applyCost,
    estimate,
    items,
    picks,
    tab,
    page,
    pages,
  } = useKeepLastData<LoaderData>(useLoaderData<typeof clientLoader>());
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const openConfirm = useConfirm();
  // Selection belongs to one view (tab/page/phase); switching view starts empty.
  const viewKey = `${tab}|${page}|${job.status}`;
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>({ key: viewKey, ids: new Set() });
  const selected = selection.key === viewKey ? selection.ids : NO_SELECTION;
  const setSelected = (update: (prev: Set<string>) => Set<string>) =>
    setSelection((prev) => ({ key: viewKey, ids: update(prev.key === viewKey ? prev.ids : new Set()) }));
  const [showMask, setShowMask] = useState(false);
  // What is being submitted right now, for the loading state of the button that sent it.
  const pendingForm = navigation.state !== "idle" && navigation.formMethod === "POST" ? navigation.formData : undefined;
  const pendingIntent = pendingForm ? String(pendingForm.get("intent")) : null;
  const pendingIds = pendingForm ? pendingForm.getAll("itemId").map(String) : [];
  const loadingFor = (intent: string) => (pendingIntent === intent ? { loading: true } : {});

  const n = (s: JobItemStatus) => counts[s] ?? 0;
  const total = Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
  const restoring = n("restore_queued") + n("restoring");
  // Progress numbers, polled every few seconds while the job runs (useLiveJob reloads the rest
  // of the page when something it shows changes), and the cleaning strip's images while processing.
  const { job: live, activity } = useLiveJob(job.id, loaderLive, {
    restoring: restoring > 0,
    autoStart: job.autoStart,
    activity: loaderActivity,
  });
  const aspectRatio = job.preset.aspect === "4:5" ? "4 / 5" : "1 / 1";
  const status = jobDisplayStatus(job.status, counts, { needsCredits: loaderLive.needsAction === "credits" });
  const canReview = job.status === "review";
  // retryFailed takes failed images in review, or after the job is done.
  const canRetry = job.status === "review" || job.status === "done";
  // Previews left behind when a review is finished, expires (maintenance) or the job is cancelled.
  const unapplied = ["done", "cancelled"].includes(job.status) ? n("ready") + n("flagged") + n("approved") : 0;
  // Applied (or since restored) images were charged and changed the store, whatever happens next.
  const everApplied = n("applied") + restoring + n("restored");
  const actionError = actionData && "error" in actionData ? actionData.error : undefined;
  const needsCredits = Boolean(actionData && "needsCredits" in actionData && actionData.needsCredits);

  // Errors also stay on the page as a banner: a toast alone disappears before it can be read.
  useEffect(() => {
    if (actionData && "message" in actionData && actionData.message) shopify.toast.show(actionData.message);
    if (actionData && "error" in actionData && actionData.error) shopify.toast.show(actionData.error, { isError: true });
  }, [actionData, shopify]);

  const act = (intent: string, ids: string[] = []) => {
    const fd = new FormData();
    fd.set("intent", intent);
    ids.forEach((id) => fd.append("itemId", id));
    submit(fd, { method: "post" });
    if (ids.length > 1) setSelected(() => new Set());
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Only cards on this page can be selected; the bulk buttons offer what fits the selection.
  const selectedItems = items.filter((i) => selected.has(i.id));
  const idsWith = (...statuses: JobItemStatus[]) =>
    selectedItems.filter((i) => statuses.includes(i.status)).map((i) => i.id);
  const allOnPage = useMemo(
    () => items.filter((i) => isSelectable(i.status, canReview, canRetry)).map((i) => i.id),
    [items, canReview, canRetry],
  );

  const tabHref = (id: string) => `?tab=${id}`;
  const tabCount = (id: string) => {
    const t = TABS.find((x) => x.id === id)!;
    return t.statuses ? t.statuses.reduce((s, st) => s + n(st), 0) : total;
  };

  const insufficient = estimate != null && estimate.cost > credits.available;
  const nothingSelected = estimate != null && estimate.selected === 0;

  const finished = job.status === "review" || job.status === "done" ? finishedCopy(job.status, counts) : null;
  // For screen readers, once per change of phase: "Your images are ready. 97 successfully
  // processed. 3 need attention."
  const phaseAnnouncement =
    job.status === "processing" || job.status === "applying"
      ? phaseCopy(job.status).heading
      : finished
        ? [finished.heading, finished.done, finished.attention].filter(Boolean).join(". ") + "."
        : status.label;
  // "Review results" opens the images still to review, or all of them once every one is decided.
  const finishedTab = finished?.link?.tab === "review" && tabCount("review") === 0 ? "all" : finished?.link?.tab;
  const retryingAll = pendingIntent === "retry" && pendingIds.length === 0;

  return (
    <s-page heading={job.heading} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/jobs">
        Jobs
      </s-link>

      {job.status === "review" && (
        <>
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={() => openConfirm(CONFIRM_APPLY)}
            {...(n("approved") === 0 ? { disabled: true } : {})}
            {...loadingFor("apply")}
          >
            Apply {num(n("approved"))} approved
          </s-button>
          {/* READY images only: every automatic check passed and nothing is flagged. */}
          <s-button slot="secondary-actions" onClick={() => act("approveAll")} {...loadingFor("approveAll")}>
            Approve all that passed checks ({num(n("ready"))})
          </s-button>
          <s-button
            slot="secondary-actions"
            onClick={() => (n("approved") > 0 ? openConfirm(CONFIRM_FINISH) : act("finish"))}
            {...loadingFor("finish")}
          >
            Finish job
          </s-button>
        </>
      )}
      {job.status === "estimated" && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => act("start")}
          {...(insufficient || nothingSelected ? { disabled: true } : {})}
          {...loadingFor("start")}
        >
          Start processing{estimate ? ` (${num(estimate.selected)})` : ""}
        </s-button>
      )}
      {["reading", "estimated", "processing"].includes(job.status) && (
        <s-button
          slot="secondary-actions"
          tone="critical"
          onClick={() => (job.status === "processing" ? openConfirm(CONFIRM_CANCEL) : act("cancel"))}
          {...loadingFor("cancel")}
        >
          Cancel job
        </s-button>
      )}
      {job.status === "applying" && (
        <s-button slot="secondary-actions" onClick={() => openConfirm(CONFIRM_STOP_APPLY)} {...loadingFor("stopApply")}>
          Stop applying
        </s-button>
      )}
      {n("applied") > 0 && (
        <s-button slot="secondary-actions" onClick={() => openConfirm(CONFIRM_RESTORE_ALL)}>
          Restore all applied ({num(n("applied"))})
        </s-button>
      )}

      {actionError && (
        <s-banner tone="critical" heading={needsCredits ? "Not enough credits" : "That didn't work"}>
          {actionError}{" "}
          {needsCredits ? (
            <s-link href="/app/billing">Buy credits</s-link>
          ) : (
            <>
              If it keeps happening, <SupportLink>contact support</SupportLink>.
            </>
          )}
        </s-banner>
      )}

      {/* Notices the job collected: images skipped (another job has them), a capped selection,
          an apply that was stopped. */}
      {job.notices.map((notice) => (
        <s-banner key={notice} tone="info">
          {notice}
        </s-banner>
      ))}

      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={status.tone}>{status.label}</s-badge>
            {/* Read out when the phase changes, not on every poll. */}
            <LiveStatus text={phaseAnnouncement} />
            <s-text color="subdued">
              {job.selection} · {job.preset.aspect} · margin {job.preset.marginPct}% ·{" "}
              {job.preset.removeBg ? `background ${job.preset.bgColor}` : "keep background"}
              {job.preset.upscale ? ` · AI upscale under ${job.preset.upscaleThresholdPx}px` : ""} · created{" "}
              {formatDate(job.createdAt)}
            </s-text>
          </s-stack>

          {job.status === "reading" && (
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-spinner accessibilityLabel="Reading" size="base" />
                <s-text>Reading your products from Shopify… Big catalogs can take a few minutes.</s-text>
              </s-stack>
              {live.total > 0 && <s-text>Found {plural(live.total, "image")} so far.</s-text>}
              {job.autoStart && (
                <s-text color="subdued">Processing starts on its own once your products are read.</s-text>
              )}
              <s-text color="subdued">You can safely leave this page. We&apos;ll keep working.</s-text>
            </s-stack>
          )}

          {job.failure !== null && (
            <s-banner tone="critical" heading="This job couldn't run">
              {job.failure} Nothing on your store was changed and no credits were used. If it keeps happening,{" "}
              <SupportLink>contact support</SupportLink>.
              <s-button slot="secondary-actions" href="/app/jobs/new">
                Start a new job
              </s-button>
            </s-banner>
          )}

          {job.noMatch !== null && (
            <s-banner tone="info" heading="No images to process">
              {job.noMatch} Try a different selection, or check that your products have images. No credits were
              used.
              <s-button slot="secondary-actions" href="/app/jobs/new">
                Change selection
              </s-button>
              <s-button slot="secondary-actions" href="shopify://admin/products">
                Open products
              </s-button>
            </s-banner>
          )}

          {job.status === "estimated" && estimate && (
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Found <s-text type="strong">{num(estimate.total)} images</s-text> across {num(estimate.products)}{" "}
                products. <s-text type="strong">{num(estimate.selected)} selected</s-text>: untick any you don&apos;t
                want processed.
              </s-paragraph>
              <div style={{ maxWidth: 520 }}>
                <CostRow
                  label={`Clean & match (${num(estimate.selected)} × 1)`}
                  value={creditsLabel(estimate.selected)}
                />
                {job.preset.upscale && (
                  <CostRow
                    label={`AI upscaling, at most (${num(estimate.eligible)} × 1)`}
                    value={creditsLabel(estimate.eligible)}
                  />
                )}
                <CostRow label="Reserved when you start" value={creditsLabel(estimate.cost)} strong />
                <CostRow label="Available now" value={creditsLabel(credits.available)} />
              </div>
              <s-text color="subdued">
                You&apos;re only charged for images you apply. Rejected and failed images, and anything you don&apos;t
                apply, cost nothing.
              </s-text>
              {insufficient && (
                <s-banner tone="warning" heading={job.creditsBlocked ? "Not enough credits to start" : "Not enough credits"}>
                  {job.creditsBlocked
                    ? "This job was set to start on its own once its images were read, but there weren't enough credits. "
                    : ""}
                  You need {creditsLabel(estimate.cost - credits.available)} more.{" "}
                  <s-link href="/app/billing">Buy credits</s-link> or untick some images.
                </s-banner>
              )}
            </s-stack>
          )}

          {job.status === "processing" && (
            <RunningPanel phase="processing" progress={live} waiting={live.waitingForEarlierJob}>
              {live.failed > 0 && (
                <s-text color="subdued">You can retry failed images when processing finishes.</s-text>
              )}
            </RunningPanel>
          )}
          {/* The images in flight and the ones that just finished, under the real counts. */}
          {job.status === "processing" && (
            <CleaningStrip
              activity={activity}
              aspectRatio={aspectRatio}
              waiting={live.waitingForEarlierJob}
              remaining={live.remaining}
            />
          )}
          {job.status === "applying" && (
            <RunningPanel phase="applying" progress={live}>
              {live.failed > 0 && (
                <s-text color="subdued">
                  Images that couldn&apos;t be updated cost nothing. You can retry them when applying finishes.
                </s-text>
              )}
            </RunningPanel>
          )}

          {finished && (
            <FinishedPanel
              copy={finished}
              linkHref={finishedTab ? tabHref(finishedTab) : null}
              failed={n("failed")}
              onRetry={() => act("retry")}
              retrying={retryingAll}
            />
          )}

          {job.status === "review" && job.reviewExpiresAt && (
            <s-text color="subdued">
              Previews you haven&apos;t applied expire on {formatDay(job.reviewExpiresAt)}. After that this job closes
              and its reserved credits are freed.
            </s-text>
          )}
          {unapplied > 0 && (
            <s-text color="subdued">
              This job closed before {unapplied === 1 ? "this preview was" : "these previews were"} applied. Start a
              new job to process {unapplied === 1 ? "it" : "them"} again.
            </s-text>
          )}
          {restoring > 0 && <s-text>Restoring {plural(restoring, "image")}…</s-text>}
          {n("applied") > 0 && (
            <s-text color="subdued">
              Shopify&apos;s CDN can keep showing the old image on your storefront for a few minutes after a change.
            </s-text>
          )}
        </s-stack>
      </s-section>

      {job.status === "estimated" && estimate && (
        <s-section heading="Images to process">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-button onClick={() => act("includeAll")} {...loadingFor("includeAll")}>
                Select all
              </s-button>
              <s-button variant="tertiary" onClick={() => act("excludeAll")} {...loadingFor("excludeAll")}>
                Deselect all
              </s-button>
              <s-text color="subdued">
                {num(estimate.selected)} of {num(estimate.total)} selected
              </s-text>
            </s-stack>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
              {picks.map((item) => (
                <PickCard key={item.id} item={item} showUpscale={job.preset.upscale} />
              ))}
            </div>
            {pages > 1 && (
              <s-stack direction="inline" gap="base" justifyContent="center" alignItems="center">
                {page > 1 && <s-button href={`?page=${page - 1}`}>Previous</s-button>}
                <s-text color="subdued">
                  Page {page} of {pages}
                </s-text>
                {page < pages && <s-button href={`?page=${page + 1}`}>Next</s-button>}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      {!["reading", "estimated", "failed"].includes(job.status) && job.noMatch === null && (
        <s-section>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small">
              {TABS.map((t) => (
                <s-button key={t.id} href={tabHref(t.id)} variant={t.id === tab ? "primary" : "secondary"}>
                  {t.label} ({num(tabCount(t.id))})
                </s-button>
              ))}
            </s-stack>

            <s-stack direction="inline" gap="base" alignItems="center">
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={allOnPage.length > 0 && allOnPage.every((id) => selected.has(id))}
                  onChange={(e) => setSelected(() => (e.target.checked ? new Set(allOnPage) : new Set()))}
                />
                Select page
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
                Show cut-out mask
              </label>
              {selectedItems.length > 0 && (
                <>
                  <s-text>{selectedItems.length} selected</s-text>
                  {canReview && idsWith("ready", "flagged").length > 0 && (
                    <s-button onClick={() => act("approve", idsWith("ready", "flagged"))}>Approve selected</s-button>
                  )}
                  {canReview && idsWith("ready", "flagged", "approved").length > 0 && (
                    <s-button onClick={() => act("reject", idsWith("ready", "flagged", "approved"))}>
                      Keep original for selected
                    </s-button>
                  )}
                  {canReview && idsWith(...RETRY_STRONGER).length > 0 && (
                    <s-button onClick={() => act("retryStronger", idsWith(...RETRY_STRONGER))}>
                      Retry selected with stronger model
                    </s-button>
                  )}
                  {canReview && idsWith("approved", "rejected").length > 0 && (
                    <s-button variant="tertiary" onClick={() => act("reset", idsWith("approved", "rejected"))}>
                      Undo decision
                    </s-button>
                  )}
                  {canRetry && idsWith("failed").length > 0 && (
                    <s-button onClick={() => act("retry", idsWith("failed"))}>Retry selected</s-button>
                  )}
                  {idsWith("applied").length > 0 && (
                    <s-button variant="tertiary" onClick={() => act("restore", idsWith("applied"))}>
                      Restore selected
                    </s-button>
                  )}
                </>
              )}
            </s-stack>

            {items.length ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                  gap: 12,
                }}
              >
                {items.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    aspectRatio={aspectRatio}
                    showMask={showMask}
                    selected={selected.has(item.id)}
                    canReview={canReview}
                    canRetry={canRetry}
                    pending={pendingIds.includes(item.id) ? pendingIntent : null}
                    onToggle={() => toggle(item.id)}
                    onAction={act}
                  />
                ))}
              </div>
            ) : (
              <s-paragraph>
                <s-text color="subdued">
                  {job.status === "processing" ? "Results appear here as images finish." : "Nothing here."}
                </s-text>
              </s-paragraph>
            )}

            {pages > 1 && (
              <s-stack direction="inline" gap="base" justifyContent="center" alignItems="center">
                {page > 1 && <s-button href={`?tab=${tab}&page=${page - 1}`}>Previous</s-button>}
                <s-text color="subdued">
                  Page {page} of {pages}
                </s-text>
                {page < pages && <s-button href={`?tab=${tab}&page=${page + 1}`}>Next</s-button>}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      <HelpFooter />

      {job.status === "review" && (
        <>
          <ConfirmModal
            id={CONFIRM_APPLY}
            heading={`Apply ${plural(n("approved"), "image")} to your store?`}
            confirmLabel={`Apply ${plural(n("approved"), "image")}`}
            onConfirm={() => act("apply")}
          >
            <s-paragraph>
              This replaces the live product images on your store with the approved versions and uses up to{" "}
              {plural(applyCost, "credit")}.
            </s-paragraph>
            <s-paragraph>
              Every original is backed up, and you can restore any of them later for free. Restoring doesn&apos;t
              return the credits used. Images that fail to apply cost nothing.
            </s-paragraph>
          </ConfirmModal>
          <ConfirmModal
            id={CONFIRM_FINISH}
            heading="Finish without applying?"
            confirmLabel="Finish job"
            cancelLabel="Keep reviewing"
            critical
            onConfirm={() => act("finish")}
          >
            <s-paragraph>
              {n("approved") === 1
                ? "1 approved image hasn't been applied yet. Finishing closes this job without applying it, and frees the credits reserved for it."
                : `${num(n("approved"))} approved images haven't been applied yet. Finishing closes this job without applying them, and frees the credits reserved for them.`}
            </s-paragraph>
            <s-paragraph>Nothing on your store changes.</s-paragraph>
          </ConfirmModal>
        </>
      )}
      {job.status === "processing" && (
        <ConfirmModal
          id={CONFIRM_CANCEL}
          heading="Cancel this job?"
          confirmLabel="Cancel job"
          cancelLabel="Keep processing"
          critical
          onConfirm={() => act("cancel")}
        >
          {everApplied > 0 ? (
            // Retry failed can reopen processing after some images were already applied.
            <s-paragraph>
              Processing stops, and previews made so far can&apos;t be reviewed or applied. Images already applied
              stay as they are, and you can still restore them. No more credits are used.
            </s-paragraph>
          ) : (
            <s-paragraph>
              Processing stops, and previews made so far can&apos;t be reviewed or applied. Nothing on your store has
              changed and no credits are used.
            </s-paragraph>
          )}
        </ConfirmModal>
      )}
      {job.status === "applying" && (
        <ConfirmModal
          id={CONFIRM_STOP_APPLY}
          heading="Stop applying?"
          confirmLabel="Stop applying"
          cancelLabel="Keep applying"
          onConfirm={() => act("stopApply")}
        >
          <s-paragraph>
            No more images are written to your store. Images already updated stay updated, and any being written
            right now finish (and are charged as usual).
          </s-paragraph>
          <s-paragraph>
            The rest stay approved: apply them later, or finish the job to free the credits reserved for them.
          </s-paragraph>
        </ConfirmModal>
      )}
      {n("applied") > 0 && (
        <ConfirmModal
          id={CONFIRM_RESTORE_ALL}
          heading={`Restore ${plural(n("applied"), "original image")}?`}
          confirmLabel={`Restore ${plural(n("applied"), "image")}`}
          critical
          onConfirm={() => act("restoreAll")}
        >
          <s-paragraph>
            This puts the original photos back on your products, replacing the cleaned versions applied by this job.
          </s-paragraph>
          <s-paragraph>Restoring is free, but it doesn&apos;t return the credits used to apply them.</s-paragraph>
        </ConfirmModal>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <RouteErrorBoundary
      notFound={{
        heading: "We couldn't find that job",
        message: "The link may be out of date. Your jobs are listed on the Jobs page.",
        backHref: "/app/jobs",
        backLabel: "Back to jobs",
      }}
    />
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
