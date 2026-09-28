import { useEffect, useMemo, useRef, useState } from "react";
import { isRouteErrorResponse, useLocation, useNavigation, useRevalidator } from "react-router";
import type { ApiJob } from "../lib/api.server";
import { isPollingStatus } from "../lib/progress";
import {
  activityKey,
  activityUrl,
  chooseActivity,
  isItemsPage,
  toActivity,
  type JobActivity,
  type PolledActivity,
} from "./cleaning/activity";

/** How often a running job is polled. */
export const POLL_MS = 3000;
/** Slowest poll after repeated failures (network blip, deploy). */
export const POLL_MAX_MS = 60_000;
/**
 * Counts-only changes reload the page data (the grid) at most this often; the numbers update
 * every poll. Restores (not in ApiJob's counts) reload on this pace too, and so does the next
 * reload after one failed.
 */
export const REFRESH_MIN_MS = 10_000;
/** An API job starts itself right after reading: keep watching this long for it to do so. */
export const AUTO_START_WATCH_MS = 60_000;
/** Reloads after polling stops, in case the reload for the final status was skipped or failed. */
export const LATE_REFRESH_MS = [5_000, 20_000] as const;
/** The cleaning strip's request gives up after this long (the numbers never wait for it). */
export const ACTIVITY_TIMEOUT_MS = 8_000;

/** A change here means the page's buttons, tabs or banners are out of date: reload at once. */
const stateKey = (j: ApiJob) => [j.phase, j.status, j.needsAction ?? "", j.notice ?? "", j.waitingForEarlierJob].join("|");
const countsKey = (j: ApiJob) => [j.total, j.completed, j.failed, j.processing, j.queued].join("|");

/** Delay before the next poll: POLL_MS, doubling per consecutive failure up to POLL_MAX_MS. */
export function nextPollDelay(failures: number): number {
  return failures > 0 ? Math.min(POLL_MAX_MS, POLL_MS * 2 ** failures) : POLL_MS;
}

// ─── Automatic reloads that keep the page when they fail ────────────────────

/**
 * The page reload useLiveJob started (not the merchant), by path and query. A reload that
 * fails on a passing error keeps the last data on screen, as a failed poll does, instead of
 * replacing the page with its error boundary: see keepLastDataOnError.
 */
const autoRefresh = { url: null as string | null, seq: 0, failedAt: 0 };

/** Path and query of a page, serialized the same way for the router's location and a request's URL. */
function pageKey(href: string): string {
  const url = new URL(href, "http://page.invalid");
  return `${url.pathname}${url.search}`;
}

/** Worth riding out: the network, a 5xx (a deploy, a database blip). Not found, auth and redirects go on. */
function isPassingLoadError(error: unknown): boolean {
  if (error instanceof Response) return error.status >= 500;
  if (isRouteErrorResponse(error)) return error.status >= 500;
  return true;
}

/**
 * For the job page's clientLoader: true when the load that failed with `error` was
 * useLiveJob's own reload of that page and the error is a passing one. The clientLoader then
 * returns KEEP_LAST_DATA, and useKeepLastData keeps rendering the last data.
 */
export function keepLastDataOnError(requestUrl: string, error: unknown): boolean {
  if (autoRefresh.url !== pageKey(requestUrl) || !isPassingLoadError(error)) return false;
  autoRefresh.failedAt = Date.now();
  return true;
}

/** What the job page's clientLoader returns for a failed automatic reload. */
export const KEEP_LAST_DATA = { keepLastData: true } as const;
export type KeepLastData = typeof KEEP_LAST_DATA;

const isKeepLastData = (x: object): x is KeepLastData => "keepLastData" in x && x.keepLastData === true;

/** The loader data to render: the latest, or the last real data when a reload returned KEEP_LAST_DATA. */
export function useKeepLastData<T extends object>(loaded: T | KeepLastData): T {
  const keep = isKeepLastData(loaded);
  const [last, setLast] = useState<T | null>(keep ? null : (loaded as T));
  if (!keep && loaded !== last) setLast(loaded as T);
  if (!keep) return loaded as T;
  // KEEP_LAST_DATA only answers a reload of a page that is showing data.
  if (!last) throw new Error("The job page has no data to keep");
  return last;
}

interface Latest {
  loaderJob: ApiJob;
  loaderActivity: JobActivity | null;
  /** The freshest known phase (last poll, or the loader's). */
  phase: ApiJob["phase"];
  revalidator: ReturnType<typeof useRevalidator>;
  idle: boolean;
  restoring: boolean;
  refreshedAt: number;
  onlyAutoStart: boolean;
  updatedAt: string;
  url: string;
}

function startAutoRefresh(l: Latest) {
  const seq = ++autoRefresh.seq;
  autoRefresh.url = l.url;
  l.refreshedAt = Date.now();
  const done = () => {
    if (autoRefresh.seq === seq) autoRefresh.url = null;
  };
  l.revalidator.revalidate().then(done, done);
}

/** A reload can start now: nothing else is loading or submitting. */
const canRefresh = (l: Latest) => l.idle && l.revalidator.state === "idle";

/**
 * Live progress for the job page. While the job is running it polls GET /api/image-jobs/:jobId
 * (the same ApiJob the loader sends as `loaderJob`) every 3 s with the tab visible, and reloads
 * the page's loader only when something the page shows changed: immediately for a new status,
 * notice or next step, at most every REFRESH_MIN_MS for counts and restores. It stops once the
 * job needs the merchant (estimated, review) or is closed, then reloads twice more
 * (LATE_REFRESH_MS) in case the reload for the final status didn't happen.
 *
 * While the job is processing, each poll also fetches the cleaning strip's images (one items
 * request: the ones in flight and the last finished, see ACTIVITY_QUERY), beside the job's
 * request rather than after it: the numbers show as soon as they arrive, and the strip when
 * its answer lands. One strip request at a time: a slow one isn't doubled, and never holds the
 * next poll back. It stops with the processing phase. A strip request that fails, a reload
 * whose strip lookup failed (null) and a reload that lands with older images than the last
 * poll all keep what the strip shows (chooseActivity), so no tile unmounts and replays.
 *
 * Plain fetch rather than useFetcher().load: a fetcher's failed load (a 500, a dropped
 * connection) is thrown to the route's ErrorBoundary and would replace the whole page. Here a
 * failure keeps the last numbers on screen and retries with backoff; a failed reload does the
 * same through the page's clientLoader (keepLastDataOnError). The request is same-origin, so
 * App Bridge adds the session token (Authorization) to it, as it does for React Router's own
 * data requests.
 *
 * Returns the freshest ApiJob (the latest poll answer until the loader brings newer data) and
 * the freshest activity for the strip, which keeps the same object while its content is
 * unchanged, so a memoised strip doesn't re-render on every poll.
 */
export function useLiveJob(
  jobId: string,
  loaderJob: ApiJob,
  opts: {
    restoring: boolean;
    autoStart: boolean;
    /** The cleaning strip's data from the page loader (null unless the job was processing). */
    activity?: JobActivity | null;
  },
): { job: ApiJob; activity: JobActivity | null } {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const location = useLocation();
  // A poll answer is tied to the loader data it was compared with; a reload supersedes it.
  const [polled, setPolled] = useState<{ base: ApiJob; data: ApiJob } | null>(null);
  const live = polled && polled.base === loaderJob ? polled.data : loaderJob;
  const loaderActivity = opts.activity ?? null;
  const [polledActivity, setPolledActivity] = useState<PolledActivity | null>(null);
  // Once the page's data has left processing, the strip is gone: start the next processing phase afresh.
  if (polledActivity && loaderActivity === null && loaderJob.phase !== "processing") setPolledActivity(null);
  // The poll's answer until a reload brings newer images (a reload's failed lookup never empties the strip).
  const freshActivity = chooseActivity(jobId, loaderActivity, polledActivity);
  // The same object for the same content: a reload or poll that changed nothing re-renders nothing.
  const shownKey = activityKey(freshActivity);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activity = useMemo(() => freshActivity, [shownKey]);

  // An auto-start job between reading and starting (the poll stops after AUTO_START_WATCH_MS).
  const autoStarting = opts.autoStart && live.phase === "estimated" && live.needsAction === "start";
  const running = isPollingStatus(loaderJob.phase) || isPollingStatus(live.phase) || opts.restoring;
  const active = running || autoStarting;

  const latest = useRef<Latest>({
    loaderJob,
    loaderActivity,
    phase: live.phase,
    revalidator,
    idle: true,
    restoring: opts.restoring,
    refreshedAt: 0,
    onlyAutoStart: false,
    updatedAt: live.updatedAt,
    url: pageKey(`${location.pathname}${location.search}`),
  });
  useEffect(() => {
    latest.current.loaderJob = loaderJob;
    latest.current.loaderActivity = loaderActivity;
    latest.current.phase = live.phase;
    latest.current.revalidator = revalidator;
    latest.current.idle = navigation.state === "idle";
    latest.current.restoring = opts.restoring;
    latest.current.onlyAutoStart = !running && autoStarting;
    latest.current.updatedAt = live.updatedAt;
    latest.current.url = pageKey(`${location.pathname}${location.search}`);
  });

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The strip request under way, if any.
    let strip: AbortController | null = null;

    /** Fetch the strip's images unless a request is still under way; they're set when they land. */
    const loadStrip = () => {
      if (strip) return;
      const controller = new AbortController();
      strip = controller;
      void fetchActivity(jobId, controller.signal).then((data) => {
        if (strip === controller) strip = null;
        if (stopped || controller.signal.aborted || !data) return;
        setPolledActivity({ jobId, base: latest.current.loaderActivity, data });
      });
    };
    const stopStrip = () => {
      strip?.abort();
      strip = null;
    };

    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), ms);
    };

    const refreshIfStale = (base: ApiJob, next: ApiJob) => {
      const l = latest.current;
      // A submission or reload is under way (it brings fresh data); the next poll checks again.
      if (!canRefresh(l)) return;
      const now = Date.now();
      // The last reload failed (the page kept its data): give the server a moment.
      if (now - autoRefresh.failedAt < REFRESH_MIN_MS) return;
      const changed = stateKey(next) !== stateKey(base);
      const moved = countsKey(next) !== countsKey(base);
      // Restores don't show in ApiJob's counts: while they run, reload on the counts' pace.
      if (changed || ((moved || l.restoring) && now - l.refreshedAt >= REFRESH_MIN_MS)) startAutoRefresh(l);
    };

    const poll = async () => {
      if (stopped || inFlight) return;
      // Hidden tab: pause; the visibilitychange listener resumes.
      if (document.visibilityState !== "visible") return;
      // Waiting for an auto-start that should have happened by now: the job needs the merchant.
      const l = latest.current;
      if (l.onlyAutoStart && Date.now() - Date.parse(l.updatedAt) >= AUTO_START_WATCH_MS) return;
      inFlight = true;
      const base = latest.current.loaderJob;
      // Processing: the strip's request goes out now, beside the job's.
      const stripEarly = l.phase === "processing";
      if (stripEarly) loadStrip();
      try {
        const res = await fetch(`/api/image-jobs/${encodeURIComponent(jobId)}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Job status request failed (${res.status})`);
        const next = (await res.json()) as ApiJob;
        if (next?.id !== jobId || typeof next.phase !== "string") throw new Error("Unexpected job status response");
        failures = 0;
        if (stopped) return;
        setPolled({ base, data: next });
        // The strip only runs while processing: just started (no early request), or moved on (drop it).
        if (next.phase !== "processing") stopStrip();
        else if (!stripEarly) loadStrip();
        refreshIfStale(base, next);
      } catch {
        // Keep the last numbers on screen; try again later.
        failures += 1;
      } finally {
        inFlight = false;
        if (!stopped) schedule(nextPollDelay(failures));
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !inFlight) schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule(POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      stopStrip();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, jobId]);

  // This page's loader marks the job's notifications read ("100 product images are ready."
  // commits with the status change, so a load that shows the new phase marks it). The reload for
  // the final status can be skipped (a submission under way, a reload that just failed), and
  // polling has stopped by then: reload a little later too, so the page shows the final state
  // and a merchant who watched the job finish here doesn't find it unread on Home.
  const wasActive = useRef(active);
  useEffect(() => {
    const was = wasActive.current;
    wasActive.current = active;
    if (!was || active) return;
    const timers = LATE_REFRESH_MS.map((ms) =>
      setTimeout(() => {
        const l = latest.current;
        if (canRefresh(l) && document.visibilityState === "visible") startAutoRefresh(l);
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [active]);

  return { job: live, activity };
}

/**
 * The cleaning strip's images, or null when the request failed, timed out (ACTIVITY_TIMEOUT_MS)
 * or was aborted through `signal` (the strip keeps what it shows).
 */
async function fetchActivity(jobId: string, signal?: AbortSignal): Promise<JobActivity | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ACTIVITY_TIMEOUT_MS);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const res = await fetch(activityUrl(jobId), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const page: unknown = await res.json();
    return isItemsPage(page) ? toActivity(page) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
