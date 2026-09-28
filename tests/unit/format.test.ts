import { describe, expect, it } from "vitest";
import {
  activeJobBanner,
  finishedCopy,
  finishedSummary,
  formatEta,
  imageScopeLabel,
  jobDisplayStatus,
  jobHeading,
  jobImagesSummary,
  jobListRow,
  ledgerLabel,
  needAttention,
  phaseCopy,
  progressSummary,
  retryMessage,
  upscaleLabel,
  visibleJobNotices,
  type JobListSource,
} from "../../app/lib/format";
import { jobProgress, type StatusCounts } from "../../app/lib/progress";
import { keepLastDataOnError, nextPollDelay, POLL_MAX_MS, POLL_MS } from "../../app/components/useLiveJob";
import {
  ACTIVITY_QUERY,
  activityKey,
  activityUrl,
  chooseActivity,
  isItemsPage,
  isNewerActivity,
  keepSlots,
  RECENT_LIMIT,
  toActivity,
} from "../../app/components/cleaning/activity";
import type { ApiItem } from "../../app/lib/api.server";

describe("job status badge", () => {
  it("maps the running statuses", () => {
    expect(jobDisplayStatus("reading", {})).toEqual({ label: "Queued", tone: "info" });
    expect(jobDisplayStatus("processing", { queued: 3 }).label).toBe("Processing");
    expect(jobDisplayStatus("applying", { approved: 3 }).label).toBe("Applying");
    expect(jobDisplayStatus("cancelled", {}).label).toBe("Cancelled");
    expect(jobDisplayStatus("failed", {})).toEqual({ label: "Failed", tone: "critical" });
  });

  it("keeps the merchant's next step for jobs that wait on them", () => {
    expect(jobDisplayStatus("estimated", { queued: 2 }).label).toBe("Ready to start");
    expect(jobDisplayStatus("estimated", { queued: 2 }, { needsCredits: true }).label).toBe("Needs credits");
  });

  it("never calls a job whose previews wait for approval 'Completed'", () => {
    expect(jobDisplayStatus("review", { ready: 5 })).toEqual({ label: "Ready for review", tone: "info" });
    expect(jobDisplayStatus("review", { ready: 5, failed: 1 })).toEqual({
      label: "Ready for review, with errors",
      tone: "warning",
    });
    expect(jobDisplayStatus("review", { failed: 3 })).toEqual({ label: "Failed", tone: "critical" });
  });

  it("says 'Completed' only once images reached the store", () => {
    expect(jobDisplayStatus("done", { applied: 4 })).toEqual({ label: "Completed", tone: "success" });
    expect(jobDisplayStatus("done", { applied: 5, failed: 2 })).toEqual({ label: "Completed with errors", tone: "warning" });
    // Applied, then restored: the store was changed (and changed back).
    expect(jobDisplayStatus("done", { restored: 2 }).label).toBe("Completed");
    expect(jobDisplayStatus("done", { applied: 1, restoring: 1 }).label).toBe("Completed");
    expect(jobDisplayStatus("done", { failed: 3 })).toEqual({ label: "Failed", tone: "critical" });
    // Finished (or expired) without applying anything.
    expect(jobDisplayStatus("done", { ready: 3, rejected: 2 })).toEqual({ label: "Finished, not applied", tone: "neutral" });
    expect(jobDisplayStatus("done", { ready: 3, failed: 1 })).toEqual({ label: "Finished, not applied", tone: "neutral" });
  });

  it("shows a finished job that found nothing as a neutral 'No images'", () => {
    expect(jobDisplayStatus("done", {})).toEqual({ label: "No images", tone: "neutral" });
    expect(jobDisplayStatus("done", { ready: 0 })).toEqual({ label: "No images", tone: "neutral" });
  });
});

describe("progress wording", () => {
  it("says an ETA only when one was measured, rounded up", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(undefined)).toBeNull();
    expect(formatEta(0)).toBeNull();
    expect(formatEta(Number.NaN)).toBeNull();
    expect(formatEta(30)).toBe("less than a minute left");
    expect(formatEta(61)).toBe("about 2 min left");
    expect(formatEta(40 * 60)).toBe("about 40 min left");
    expect(formatEta(2 * 3600 + 25 * 60)).toBe("about 2 h 30 min left");
    expect(formatEta(2 * 3600 + 58 * 60)).toBe("about 3 h left");
  });

  it("reads like the spec while processing: 67 of 100 processed · 3 failed · 30 remaining", () => {
    const p = { total: 100, completed: 67, failed: 3, remaining: 30, etaSeconds: null };
    expect(progressSummary(p, "processed")).toBe("67 of 100 processed · 3 failed · 30 remaining");
    expect(progressSummary({ ...p, etaSeconds: 300 }, "processed")).toBe(
      "67 of 100 processed · 3 failed · 30 remaining · about 5 min left",
    );
    expect(progressSummary({ total: 10, completed: 10, failed: 0, remaining: 0, etaSeconds: null }, "updated")).toBe(
      "10 of 10 updated",
    );
  });

  it("words each running phase", () => {
    expect(phaseCopy("processing")).toEqual({
      heading: "Cleaning your product images",
      doneWord: "processed",
      leave: "You can safely leave this page. We'll notify you when your images are ready.",
    });
    expect(phaseCopy("applying").heading).toBe("Updating images in your store");
    expect(phaseCopy("applying").doneWord).toBe("updated");
  });

  it("uses singular forms", () => {
    expect(needAttention(1)).toBe("1 needs attention");
    expect(needAttention(1200)).toBe("1,200 need attention");
  });
});

describe("finished job copy", () => {
  it("in review: ready, how many worked and how many need attention", () => {
    expect(finishedCopy("review", { ready: 90, flagged: 7, failed: 3 })).toEqual({
      heading: "Your images are ready",
      done: "97 successfully processed",
      review: "7 need your review",
      attention: "3 need attention",
      link: { label: "Review results", tab: "review" },
    });
    expect(finishedCopy("review", { ready: 4 })?.attention).toBeNull();
    expect(finishedCopy("review", { ready: 4, flagged: 1 })?.review).toBe("1 needs your review");
  });

  it("says when photos were already clean (NO_CHANGE): nothing to apply", () => {
    expect(finishedCopy("review", { ready: 3, unchanged: 2 })).toEqual({
      heading: "Your images are ready",
      done: "5 successfully processed",
      unchanged: "2 already clean — no change needed",
      attention: null,
      link: { label: "Review results", tab: "review" },
    });
    expect(finishedCopy("review", { unchanged: 4 })?.heading).toBe("Your images are already clean");
    expect(finishedCopy("done", { unchanged: 4 })).toEqual({
      heading: "Your images are already clean",
      done: null,
      unchanged: "4 already clean — no change needed",
      attention: null,
      link: null,
    });
    expect(finishedCopy("done", { applied: 2, unchanged: 1 })).toMatchObject({
      heading: "Your store is updated",
      unchanged: "1 already clean — no change needed",
    });
  });

  it("once done: what reached the store, or that nothing could be processed", () => {
    expect(finishedCopy("done", { applied: 50, rejected: 2, failed: 1 })).toEqual({
      heading: "Your store is updated",
      done: "50 images updated in your store",
      attention: "1 needs attention",
      link: { label: "View updated images", tab: "applied" },
    });
    expect(finishedCopy("done", { failed: 3 })).toMatchObject({
      heading: "These images couldn't be processed",
      done: null,
      link: { tab: "failed" },
    });
    expect(finishedCopy("done", { failed: 1 })?.heading).toBe("This image couldn't be processed");
    expect(finishedCopy("done", { ready: 2, approved: 1 })).toMatchObject({ heading: "Job finished", link: null });
  });

  it("has nothing to say about a selection that matched no images", () => {
    expect(finishedCopy("done", {})).toBeNull();
  });
});

describe("jobs list", () => {
  const job = (over: Partial<JobListSource> = {}): JobListSource => ({
    id: "job1",
    status: "processing",
    filter: { imageScope: "first", productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"] },
    createdAt: new Date("2026-09-27T10:00:00Z"),
    autoStart: false,
    error: null,
    phaseTotal: 100,
    phaseFailedBase: 0,
    phaseStartedAt: new Date("2026-09-27T10:00:00Z"),
    ...over,
  });

  it("shows x / y while a phase runs, and ready / need attention once finished", () => {
    const running: StatusCounts = { queued: 25, processing: 5, ready: 67, failed: 3 };
    expect(jobImagesSummary("processing", jobProgress(job(), running), running)).toBe("67 / 100 · 3 failed");
    const finished: StatusCounts = { ready: 90, flagged: 7, failed: 3 };
    expect(jobImagesSummary("review", jobProgress(job({ status: "review" }), finished), finished)).toBe(
      "97 ready · 3 need attention",
    );
    expect(finishedSummary({ applied: 40, ready: 2, failed: 1 }, "done")).toBe("40 applied · 1 needs attention");
    expect(finishedSummary({ ready: 5 }, "done")).toBe("5 processed");
    expect(finishedSummary({ failed: 4 })).toBe("4 failed");
    expect(finishedSummary({})).toBe("—");
  });

  it("builds rows from display strings only: the product ids never reach the browser", () => {
    const counts: StatusCounts = { queued: 25, processing: 5, ready: 67, failed: 3 };
    const row = jobListRow(job(), counts);
    expect(row).toMatchObject({
      id: "job1",
      name: "2 selected products",
      scope: "First image of each product",
      selection: "2 selected products · first image",
      badge: { label: "Processing" },
      images: "67 / 100 · 3 failed",
    });
    expect(JSON.stringify(row)).not.toContain("gid://");
  });

  it("marks jobs waiting for review and API jobs that need credits", () => {
    expect(jobListRow(job({ status: "review" }), { ready: 3 }).badge).toEqual({ label: "Ready for review", tone: "info" });
    const blocked = job({
      status: "estimated",
      autoStart: true,
      error: "Not enough credits to start processing 3 images.",
    });
    expect(jobListRow(blocked, { queued: 3 }).badge.label).toBe("Needs credits");
  });

  it("gives Home's banner for a running job, with a measured ETA", () => {
    const started = Date.parse("2026-09-27T10:00:00Z");
    const counts: StatusCounts = { queued: 25, processing: 5, ready: 67, failed: 3 };
    expect(activeJobBanner(job(), counts, started)).toEqual({
      id: "job1",
      heading: "Cleaning your product images",
      name: "2 selected products",
      summary: "67 of 100 processed · 3 failed · 30 remaining",
    });
    // 70 images in 10 minutes: the 30 left take about 4.3 minutes.
    expect(activeJobBanner(job(), counts, started + 10 * 60_000).summary).toBe(
      "67 of 100 processed · 3 failed · 30 remaining · about 5 min left",
    );
    const applying = job({ status: "applying", phaseTotal: 10, phaseFailedBase: 3 });
    expect(activeJobBanner(applying, { approved: 4, applying: 1, applied: 5, failed: 3 }, started).summary).toBe(
      "5 of 10 updated · 5 remaining",
    );
  });
});

describe("job heading", () => {
  it("is 'All products' without a filter", () => {
    expect(jobHeading({} as never)).toBe("All products");
  });

  it("names the collection, capitalised", () => {
    expect(jobHeading({ collectionId: "gid://shopify/Collection/1", collectionTitle: "Shoes" } as never)).toBe(
      "Collection “Shoes”",
    );
  });

  it("joins several filters", () => {
    expect(jobHeading({ vendor: "Acme", tag: "sale" } as never)).toBe("Vendor “Acme”, tag “sale”");
  });

  it("counts named products or images (from the browser-safe filter)", () => {
    expect(jobHeading({ productCount: 12 })).toBe("12 selected products");
    expect(jobHeading({ productCount: 1 })).toBe("1 selected product");
    expect(jobHeading({ productCount: 12, mediaCount: 30 })).toBe("30 selected images");
    expect(imageScopeLabel({ imageScope: "all" })).toBe("All images");
    expect(imageScopeLabel({ imageScope: "first", mediaCount: 3 })).toBeNull();
  });
});

describe("job notices on the job page", () => {
  const skipped = "12 images are already in another job that hasn't finished, so they were skipped.";
  const credits = "Not enough credits to start processing 3 images. This job needs 3 credits; 1 are available.";
  const stopped = "Applying stopped. Images already written to your store stay applied.";

  it("shows one banner per notice", () => {
    expect(visibleJobNotices("processing", `${skipped}\nOnly the first 5,000 images were read.`, { queued: 1 })).toEqual([
      skipped,
      "Only the first 5,000 images were read.",
    ]);
    expect(visibleJobNotices("review", null, { ready: 1 })).toEqual([]);
  });

  it("leaves the credits notice to the estimate's live banner", () => {
    expect(visibleJobNotices("estimated", `${credits}\n${skipped}`, { queued: 3 })).toEqual([skipped]);
  });

  it("shows 'Applying stopped' only while approved images are still waiting", () => {
    expect(visibleJobNotices("review", stopped, { approved: 4, applied: 2 })).toEqual([stopped]);
    expect(visibleJobNotices("review", stopped, { ready: 4, applied: 6 })).toEqual([]);
    expect(visibleJobNotices("done", stopped, { applied: 6 })).toEqual([]);
  });

  it("says why an auto-start couldn't start only until the job starts", () => {
    const blocked = "All of these images are already in another job that hasn't finished. Start this one after it does.";
    expect(visibleJobNotices("estimated", blocked, { queued: 3 })).toEqual([blocked]);
    expect(visibleJobNotices("processing", `${blocked}\n${skipped}`, { queued: 3 })).toEqual([skipped]);
    expect(visibleJobNotices("review", blocked, { ready: 3 })).toEqual([]);
    expect(visibleJobNotices("done", blocked, { applied: 3 })).toEqual([]);
  });

  it("never repeats a failure reason or the no-match notice", () => {
    expect(visibleJobNotices("failed", "Shopify didn't answer.", {})).toEqual([]);
    expect(visibleJobNotices("done", "No product images matched this selection.", {})).toEqual([]);
  });
});

describe("job page polling", () => {
  it("polls every 3 s, backing off after failures up to a minute", () => {
    expect(nextPollDelay(0)).toBe(POLL_MS);
    expect(nextPollDelay(1)).toBe(2 * POLL_MS);
    expect(nextPollDelay(2)).toBe(4 * POLL_MS);
    expect(nextPollDelay(10)).toBe(POLL_MAX_MS);
  });

  it("lets only the page's own automatic reloads keep the last data", () => {
    // No automatic reload is running: every load error reaches the error boundary as usual.
    expect(keepLastDataOnError("https://app.test/app/jobs/job1?tab=review", new Error("boom"))).toBe(false);
  });
});

describe("retry message", () => {
  it("says 'Retrying' while the retried images are being processed or applied", () => {
    expect(retryMessage(3, 0, "processing")).toBe("Retrying 3 images");
    expect(retryMessage(1, 0, "processing")).toBe("Retrying 1 image");
    expect(retryMessage(2, 2, "applying")).toBe("Retrying 2 images");
  });

  it("says apply failures are approved again when nothing runs until the merchant applies", () => {
    expect(retryMessage(2, 2, "review")).toBe("2 images are approved again. Apply them to update your store");
    expect(retryMessage(1, 1, "review")).toBe("1 image is approved again. Apply it to update your store");
  });

  it("names both kinds when some images are reprocessed and some approved again", () => {
    expect(retryMessage(5, 2, "processing")).toBe(
      "Retrying 3 images. 2 images are approved again: apply them once processing finishes",
    );
    expect(retryMessage(2, 1, "processing")).toBe(
      "Retrying 1 image. 1 image is approved again: apply it once processing finishes",
    );
    // A stale count never says more were approved than were retried.
    expect(retryMessage(2, 9, "processing")).toBe("Retrying 2 images");
  });
});

describe("upscale label", () => {
  it("names AI upscaling with its factor", () => {
    expect(upscaleLabel("realesrgan-x2")).toBe("AI upscaled ×2");
    expect(upscaleLabel("realesrgan-x4")).toBe("AI upscaled ×4");
  });

  it("calls the non-AI resize 'Resized'", () => {
    expect(upscaleLabel("lanczos")).toBe("Resized");
  });

  it("shows nothing when no upscaling ran or the method is unknown", () => {
    expect(upscaleLabel(null)).toBeNull();
    expect(upscaleLabel("none")).toBeNull();
    expect(upscaleLabel("realesrgan-xl")).toBeNull();
  });
});

describe("credit history label", () => {
  const packs = [
    { id: "starter", name: "Starter pack" },
    { id: "growth", name: "Growth pack" },
  ];

  it("shows the pack name for older purchase rows that carry the pack id", () => {
    expect(ledgerLabel({ reason: "purchase", note: "starter pack" }, packs)).toBe("Starter pack");
  });

  it("keeps a row's own note", () => {
    expect(ledgerLabel({ reason: "apply", note: "Blue shirt" }, packs)).toBe("Blue shirt");
  });

  it("falls back to a label for the reason, then the raw reason", () => {
    expect(ledgerLabel({ reason: "free_grant", note: null }, packs)).toBe("Free credits");
    expect(ledgerLabel({ reason: "purchase", note: null }, packs)).toBe("Credit pack");
    expect(ledgerLabel({ reason: "something_new", note: null }, packs)).toBe("something_new");
  });
});

describe("cleaning strip data", () => {
  const apiItem = (id: string, over: Partial<ApiItem> = {}): ApiItem => ({
    id,
    bulkJobId: "job",
    productId: "gid://shopify/Product/1",
    productTitle: `Product ${id}`,
    mediaId: `gid://shopify/MediaImage/${id}`,
    position: 0,
    status: "completed",
    reviewStatus: "ready",
    finalStatus: "READY",
    route: "local",
    reasonCodes: [],
    strongerModel: false,
    attemptCount: 1,
    processingMethod: "local",
    errorCode: null,
    errorMessage: null,
    sourceImageUrl: `https://cdn.shopify.com/${id}.jpg`,
    thumbnailUrl: `https://cdn.shopify.com/${id}.jpg?width=400`,
    outputImageUrl: `https://s3.example.com/${id}/preview.jpg?X-Amz-Signature=x`,
    flags: [],
    durationMs: 12_000,
    updatedAt: "2026-09-27T12:00:00.000Z",
    ...over,
  });

  it("asks for the last finished images and the ones in flight, in one request", () => {
    const q = new URLSearchParams(ACTIVITY_QUERY);
    // Only what processing produces: not approved, rejected or applied images a retried job has.
    expect(Object.fromEntries(q)).toEqual({
      status: "ready,flagged,unchanged,failed",
      sort: "recent",
      limit: String(RECENT_LIMIT),
      include: "active",
    });
    expect(activityUrl("a b")).toBe(`/api/image-jobs/a%20b/items?${ACTIVITY_QUERY}`);
  });

  it("keeps only what the strip shows: in flight, finished (flagged or not) and failed", () => {
    const activity = toActivity({
      items: [
        apiItem("f", { reviewStatus: "flagged", flags: ["text_detected"] }),
        apiItem("x", { status: "failed", reviewStatus: "failed", outputImageUrl: null }),
        apiItem("q", { status: "queued", reviewStatus: "queued" }),
        ...["a", "b", "c", "d", "e"].map((id) => apiItem(id)),
      ],
      active: [apiItem("p", { status: "processing", reviewStatus: "processing", outputImageUrl: null })],
    });
    expect(activity.active).toEqual([
      {
        id: "p",
        title: "Product p",
        status: "processing",
        flagged: false,
        thumbnailUrl: "https://cdn.shopify.com/p.jpg?width=400",
        previewUrl: null,
      },
    ]);
    expect(activity.recent.map((i) => [i.id, i.status, i.flagged])).toEqual([
      ["f", "completed", true],
      ["x", "failed", false],
      ["a", "completed", false],
      ["b", "completed", false],
      ["c", "completed", false],
      ["d", "completed", false],
    ]);
    // An answer without `active` (an older server) shows nothing in flight.
    expect(toActivity({ items: [] })).toEqual({ active: [], recent: [], asOf: "" });
  });

  it("tells an older answer from a newer one by its images' last change", () => {
    const at = (iso: string) => ({ updatedAt: `2026-09-27T12:00:${iso}.000Z` });
    const older = toActivity({ items: [apiItem("a", at("10"))], active: [apiItem("p", { status: "processing", ...at("20") })] });
    // Only what the strip lists counts (not the queued row it drops).
    expect(older.asOf).toBe("2026-09-27T12:00:20.000Z");
    const newer = toActivity({ items: [apiItem("p", at("30")), apiItem("a", at("10")), apiItem("q", { status: "queued", ...at("59") })] });
    expect(newer.asOf).toBe("2026-09-27T12:00:30.000Z");
    expect(isNewerActivity(newer, older)).toBe(true);
    expect(isNewerActivity(older, newer)).toBe(false);
    // The same state: the reload's copy wins (not newer).
    expect(isNewerActivity(older, toActivity({ items: [apiItem("a", at("10"))], active: [apiItem("p", { status: "processing", ...at("20") })] }))).toBe(false);
    // Nothing to compare with (a reload whose lookup failed): the poll's answer stays.
    expect(isNewerActivity(older, null)).toBe(true);
  });

  it("keeps the poll's images over a reload that has none or older ones, until a reload brings newer", () => {
    const at = (s: string, id = "a") => toActivity({ items: [apiItem(id, { updatedAt: `2026-09-27T12:00:${s}.000Z` })] });
    const loaded = at("10");
    const polled = { jobId: "job", base: loaded, data: at("20", "b") };
    // No poll yet, or another job's answer: the loader's.
    expect(chooseActivity("job", loaded, null)).toBe(loaded);
    expect(chooseActivity("other", loaded, polled)).toBe(loaded);
    expect(chooseActivity("other", null, polled)).toBeNull();
    // The poll compared with this loader data: the poll's.
    expect(chooseActivity("job", loaded, polled)).toBe(polled.data);
    // A reload whose strip lookup failed: still the poll's (the strip isn't emptied).
    expect(chooseActivity("job", null, polled)).toBe(polled.data);
    // A reload that started before the poll and landed after it: still the poll's.
    expect(chooseActivity("job", at("15", "c"), polled)).toBe(polled.data);
    // A reload with newer images (or the same moment): the reload's.
    const newer = at("25", "d");
    expect(chooseActivity("job", newer, polled)).toBe(newer);
    const same = at("20", "b");
    expect(chooseActivity("job", same, polled)).toBe(same);
  });

  it("changes its key only when something shown changed", () => {
    const page = { items: [apiItem("a")], active: [apiItem("p", { status: "processing" })] };
    const one = toActivity(page);
    expect(activityKey(one)).toBe(activityKey(toActivity(page)));
    // A later updatedAt or duration alone isn't shown.
    expect(activityKey(one)).toBe(activityKey(toActivity({ ...page, items: [apiItem("a", { durationMs: 1, updatedAt: "x" })] })));
    expect(activityKey(one)).not.toBe(activityKey(toActivity({ ...page, items: [apiItem("a", { reviewStatus: "flagged" })] })));
    expect(activityKey(one)).not.toBe(activityKey(toActivity({ ...page, active: [] })));
    expect(activityKey(null)).toBe("");
  });

  it("recognises an items page, not an error body", () => {
    expect(isItemsPage({ items: [], page: 1 })).toBe(true);
    expect(isItemsPage({ items: [], active: [] })).toBe(true);
    expect(isItemsPage({ error: "Job not found" })).toBe(false);
    expect(isItemsPage({ items: [], active: "x" })).toBe(false);
    expect(isItemsPage(null)).toBe(false);
  });

  it("keeps each card in its slot: a new image takes the slot of one that finished", () => {
    const ids = (xs: Array<{ id: string } | null>) => xs.map((x) => x?.id ?? null);
    const items = (...xs: string[]) => xs.map((id) => ({ id }));
    // Same images, another order from the API: nothing moves.
    expect(ids(keepSlots(["b", "a"], items("a", "b", "c")))).toEqual(["b", "a", "c"]);
    // A finished, d arrived: d takes a's slot, b and c stay put.
    expect(ids(keepSlots(["a", "b", "c"], items("b", "c", "d")))).toEqual(["d", "b", "c"]);
    // A finished with nothing to replace it: its slot stays empty, b and c don't close up.
    expect(ids(keepSlots(["a", "b", "c"], items("b", "c")))).toEqual([null, "b", "c"]);
    // The next ones fill the gaps first, then go at the end.
    expect(ids(keepSlots([null, "b", "c"], items("c", "e", "b", "f")))).toEqual(["e", "b", "c", "f"]);
    // Trailing empty slots go; none left means nothing in flight.
    expect(ids(keepSlots(["a", "b", "c"], items("a")))).toEqual(["a"]);
    expect(ids(keepSlots([null, "b"], items()))).toEqual([]);
    expect(ids(keepSlots([], items("x", "y")))).toEqual(["x", "y"]);
    // A repeated id is shown once.
    expect(ids(keepSlots(["a", "a"], items("a", "a", "b")))).toEqual(["a", "b"]);
  });
});
