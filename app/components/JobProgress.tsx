import type { CSSProperties, ReactNode } from "react";
import { phaseCopy, progressSummary, type FinishedCopy } from "../lib/format";
import type { JobProgress } from "../lib/progress";
import { SupportLink } from "./HelpFooter";

/**
 * A bar for a measured percentage (JobProgress.progress, floored, so it never shows 100 while
 * an image is left). Polaris has no progress bar element.
 */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.floor(Number.isFinite(value) ? value : 0)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${pct}%`}
      style={{ height: 8, borderRadius: 4, background: "#e3e3e3", overflow: "hidden" }}
    >
      <div style={{ width: `${pct}%`, height: "100%", background: "#303030", transition: "width 0.4s" }} />
    </div>
  );
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Text for screen readers only, read out (politely) each time it changes. Keep it coarse: it
 * sits next to numbers that change on every poll, and reading those out would be noise.
 */
export function LiveStatus({ text }: { text: string }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN}>
      {text}
    </div>
  );
}

type RunningProgress = Pick<JobProgress, "total" | "completed" | "failed" | "remaining" | "progress" | "etaSeconds">;

/**
 * A processing or applying phase under way, from real counts: "Cleaning your product images ·
 * 67 of 100 processed · 3 failed · 30 remaining · about 5 min left · [bar] · You can safely
 * leave this page…". The ETA only appears once the rate was measured (etaSeconds).
 */
export function RunningPanel({
  phase,
  progress,
  waiting,
  children,
}: {
  phase: "processing" | "applying";
  progress: RunningProgress;
  /** Queued behind the shop's earlier job (the oldest job is served first). */
  waiting?: boolean;
  children?: ReactNode;
}) {
  const copy = phaseCopy(phase);
  // Announced in 10% steps, and when the job starts or stops waiting for an earlier one.
  const step = Math.floor(Math.max(0, Math.min(100, progress.progress || 0)) / 10) * 10;
  const announcement = `${copy.heading}: ${step}% ${copy.doneWord}.${
    waiting ? " Waiting for your earlier job to finish." : ""
  }`;
  return (
    <s-stack direction="block" gap="small">
      <LiveStatus text={announcement} />
      <s-heading>{copy.heading}</s-heading>
      <s-text>{progressSummary(progress, copy.doneWord)}</s-text>
      <ProgressBar value={progress.progress} label={copy.heading} />
      {waiting && <s-text type="strong">Waiting for your earlier job to finish.</s-text>}
      <s-text color="subdued">{copy.leave}</s-text>
      {children}
    </s-stack>
  );
}

/**
 * A finished phase: "Your images are ready · 97 successfully processed · 3 need attention ·
 * [Review results] [Retry failed]".
 */
export function FinishedPanel({
  copy,
  linkHref,
  failed,
  onRetry,
  retrying,
}: {
  copy: FinishedCopy;
  /** Where copy.link goes (a tab of this page). */
  linkHref: string | null;
  failed: number;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <s-stack direction="block" gap="small">
      <s-heading>{copy.heading}</s-heading>
      <s-stack direction="block" gap="small-300">
        {copy.done && <s-text tone="success">{copy.done}</s-text>}
        {copy.unchanged && <s-text>{copy.unchanged}</s-text>}
        {copy.review && <s-text tone="caution">{copy.review}</s-text>}
        {copy.attention && <s-text tone="critical">{copy.attention}</s-text>}
      </s-stack>
      {failed > 0 && (
        <s-text color="subdued">
          Failed images cost nothing. Each one says why it failed. If they keep failing,{" "}
          <SupportLink>contact support</SupportLink>.
        </s-text>
      )}
      {(copy.link || failed > 0) && (
        <s-stack direction="inline" gap="small">
          {copy.link && linkHref && <s-button href={linkHref}>{copy.link.label}</s-button>}
          {failed > 0 && (
            <s-button onClick={onRetry} {...(retrying ? { loading: true } : {})}>
              Retry failed
            </s-button>
          )}
        </s-stack>
      )}
    </s-stack>
  );
}
