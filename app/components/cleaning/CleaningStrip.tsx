import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { plural } from "../../lib/format";
import { keepSlots, RECENT_LIMIT, type CleaningItem, type JobActivity } from "./activity";
import styles from "./cleaning.module.css";

/** Delay between the reveals of the images already finished when the page opens. */
const STAGGER_MS = 160;
/** A preview that didn't load is tried again after this long, times the failures so far… */
const PREVIEW_RETRY_MS = 5_000;
/** …this many times in all (a new URL, the next signature, starts over). */
const PREVIEW_TRIES = 4;

/** A steady per-image start offset, so two cards being cleaned don't sweep in lockstep. */
function sweepOffset(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `${-((h % 9) * 0.4).toFixed(1)}s`;
}

/** Each already-finished image's place in the first data the strip gets. */
const batchOf = (activity: JobActivity | null) =>
  activity ? new Map(activity.recent.map((item, i) => [item.id, i] as const)) : null;

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** The brush head riding at the front of a stroke. Decorative. */
function BrushHead({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 40 64" aria-hidden="true" focusable="false">
      <g transform="rotate(38 20 40)">
        <rect x="16.5" y="-4" width="7" height="34" rx="3.5" fill="#4a4a4a" />
        <rect x="14.5" y="28" width="11" height="10" rx="1.5" fill="#c9ccd1" stroke="#8a8f98" strokeWidth="0.8" />
        <path d="M15 38 H25 C25.6 45 25 51 23.2 57 H16.8 C15 51 14.4 45 15 38 Z" fill="#fbfaf7" stroke="#8a8f98" strokeWidth="0.8" />
        <path d="M18 40 V55 M20 40 V56 M22 40 V55" stroke="#d9d6cf" strokeWidth="0.6" />
      </g>
    </svg>
  );
}

function Photo({ src, alt, className }: { src: string | null; alt: string; className: string }) {
  if (!src) return <div className={cx(className, styles.noPhoto)} role="img" aria-label={alt || "No preview"} />;
  return <img className={className} src={src} alt={alt} loading="eager" decoding="async" draggable={false} />;
}

/**
 * An image in flight (claimed for processing: being worked on, or next in line at the image
 * service): its original under a brush that keeps sweeping. The animation is decorative: it
 * doesn't track the image's real progress, and says nothing about it.
 */
function CleaningCard({ item, aspectRatio }: { item: CleaningItem; aspectRatio: string }) {
  const title = item.title || "Untitled product";
  return (
    <li className={styles.card} style={{ "--sweep-offset": sweepOffset(item.id) } as CSSProperties}>
      <div className={cx(styles.frame, styles.cleaning)} style={{ aspectRatio }}>
        <Photo className={styles.photo} src={item.thumbnailUrl} alt={`Original photo: ${title}`} />
        <div className={styles.wash} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className={styles.stroke} aria-hidden="true">
          <span className={styles.bristles} />
          <BrushHead className={styles.brushHead} />
        </div>
        <div className={styles.scan} aria-hidden="true" />
        <span className={styles.pill}>
          <span className={styles.dot} aria-hidden="true" />
          Processing
        </span>
      </div>
      <p className={styles.title} title={title}>
        {title}
      </p>
    </li>
  );
}

/**
 * A finished image. A processed one plays a single brush stroke from the original to the
 * cleaned preview once the preview has loaded (then stays still); a flagged one says "Check"
 * once revealed; a failed one stays on its original, greyed out. A preview that doesn't load
 * (a deploy, a proxy blip, an expired signature) leaves the original with "No preview" and is
 * tried again a little later, a few times; a new URL from a later poll is tried at once.
 */
function RecentTile({ item, aspectRatio, delayMs }: { item: CleaningItem; aspectRatio: string; delayMs: number }) {
  const title = item.title || "Untitled product";
  const failed = item.status === "failed";
  const previewRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  // The preview URL that failed to load, how often, and whether it's waiting to be tried again.
  const [failure, setFailure] = useState<{ url: string; count: number; waiting: boolean } | null>(null);
  const failedUrl = failure !== null && failure.url === item.previewUrl ? failure : null;
  const broken = failedUrl?.waiting ?? false;
  // Loaded before hydration (server-rendered): onLoad already fired.
  useEffect(() => {
    const img = previewRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);
  // Try a preview that didn't load again (the <img> is rendered anew), unless it failed too often.
  useEffect(() => {
    if (!failedUrl?.waiting || failedUrl.count >= PREVIEW_TRIES) return;
    const timer = setTimeout(
      () => setFailure((f) => (f === failedUrl ? { ...f, waiting: false } : f)),
      PREVIEW_RETRY_MS * failedUrl.count,
    );
    return () => clearTimeout(timer);
  }, [failedUrl]);
  const reveal = !failed && Boolean(item.previewUrl) && !broken;

  return (
    <li className={cx(styles.tile, failed && styles.failed)}>
      <div
        className={cx(styles.frame, reveal && (loaded ? styles.play : styles.pending))}
        style={{ aspectRatio, "--reveal-delay": `${delayMs}ms` } as CSSProperties}
      >
        {reveal && (
          <img
            ref={previewRef}
            className={styles.photoFill}
            src={item.previewUrl!}
            alt={`Cleaned: ${title}`}
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => {
              const url = item.previewUrl!;
              setFailure((f) => ({ url, count: f?.url === url ? f.count + 1 : 1, waiting: true }));
              setLoaded(false);
            }}
          />
        )}
        {/* The original on top; the stroke wipes it away to show the preview under it. */}
        <div className={cx(styles.before, !reveal && styles.beforeStill)}>
          <Photo className={styles.photo} src={item.thumbnailUrl} alt={reveal ? "" : `Original photo: ${title}`} />
        </div>
        {reveal && (
          <div className={styles.revealStroke} aria-hidden="true">
            <span className={styles.bristles} />
            <BrushHead className={styles.brushHead} />
          </div>
        )}
        {failed ? (
          <span className={cx(styles.badge, styles.badgeMuted)}>Failed</span>
        ) : broken ? (
          <span className={cx(styles.badge, styles.badgeMuted)} title="The preview couldn't be loaded here.">
            No preview
          </span>
        ) : item.flagged ? (
          <span className={cx(styles.badge, styles.badgeCheck)} title="Flagged by the automatic checks: look at it before approving">
            Check
          </span>
        ) : null}
      </div>
      <p className={styles.title} title={title}>
        {title}
      </p>
    </li>
  );
}

function EmptySlot({ aspectRatio, children }: { aspectRatio: string; children?: string }) {
  return (
    <li className={styles.slot} aria-hidden={children ? undefined : true}>
      <div className={cx(styles.frame, styles.slotFrame)} style={{ aspectRatio }}>
        {children && <span className={styles.slotText}>{children}</span>}
      </div>
      <p className={styles.title}>{"\u00a0"}</p>
    </li>
  );
}

/**
 * Under the job's counts while it processes: "In progress", the images in flight (claimed for
 * processing: some may still be waiting their turn at the image service) with a brush sweeping
 * over each, and "Just cleaned", the last finished ones revealing their result. Only real
 * images and real results; the counts panel above stays the measure of progress. Every box has
 * a fixed size (the output's aspect ratio, title line included) and empty slots are kept; a
 * card keeps its slot until its image finishes (keepSlots), so nothing moves when images
 * arrive or leave. Memoised: an unchanged poll hands over the same `activity` object.
 */
export const CleaningStrip = memo(function CleaningStrip({
  activity,
  aspectRatio,
  waiting = false,
  remaining,
}: {
  activity: JobActivity | null;
  /** CSS aspect-ratio of the output, e.g. "1 / 1" or "4 / 5". */
  aspectRatio: string;
  /** Queued behind the shop's earlier job. */
  waiting?: boolean;
  /** Images left to process (queued + processing). */
  remaining: number;
}) {
  // Cards keep their slot between polls; a new image takes the slot of one that finished.
  const incoming = activity?.active;
  const [slotIds, setSlotIds] = useState<{ from: CleaningItem[] | undefined; ids: Array<string | null> }>(() => ({
    from: incoming,
    ids: (incoming ?? []).map((i) => i.id),
  }));
  const slots = useMemo(() => keepSlots(slotIds.ids, incoming ?? []), [slotIds.ids, incoming]);
  if (slotIds.from !== incoming) setSlotIds({ from: incoming, ids: slots.map((i) => i?.id ?? null) });
  const inFlight = slots.reduce((n, i) => (i ? n + 1 : n), 0);

  // Images already finished when the strip first has data reveal one after another; later ones at once.
  const [firstBatch, setFirstBatch] = useState<Map<string, number> | null>(() => batchOf(activity));
  if (firstBatch === null && activity) setFirstBatch(batchOf(activity));
  const delayFor = (id: string) => (firstBatch?.get(id) ?? 0) * STAGGER_MS;

  const recent = activity?.recent.slice(0, RECENT_LIMIT) ?? [];
  const idleText = !activity
    ? "Loading…"
    : waiting
      ? "Starts after your earlier job"
      : remaining === 0
        ? "Finishing up…"
        : "Waiting for the next image…";

  return (
    <div className={styles.strip}>
      <section className={styles.group} aria-label="In progress">
        <h3 className={styles.label}>
          In progress
          {inFlight > 0 && <span className={styles.count}> · {plural(inFlight, "image")}</span>}
        </h3>
        <ul className={styles.activeGrid}>
          {slots.length > 0 ? (
            slots.map((item, i) =>
              item ? (
                <CleaningCard key={item.id} item={item} aspectRatio={aspectRatio} />
              ) : (
                <EmptySlot key={`left-${i}`} aspectRatio={aspectRatio} />
              ),
            )
          ) : (
            <EmptySlot aspectRatio={aspectRatio}>{idleText}</EmptySlot>
          )}
        </ul>
      </section>

      <section className={styles.group} aria-label="Just cleaned">
        <h3 className={styles.label}>Just cleaned</h3>
        <ul className={styles.recentGrid}>
          {recent.map((item) => (
            <RecentTile key={item.id} item={item} aspectRatio={aspectRatio} delayMs={delayFor(item.id)} />
          ))}
          {Array.from({ length: RECENT_LIMIT - recent.length }, (_, i) => (
            <EmptySlot key={`empty-${i}`} aspectRatio={aspectRatio}>
              {recent.length === 0 && i === 0 ? "Cleaned images appear here" : undefined}
            </EmptySlot>
          ))}
        </ul>
      </section>
    </div>
  );
});
