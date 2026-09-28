import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { PAGES } from "../../lib/brand";
import type { action } from "../../routes/try";
import { BrushStage, type TryAspect } from "./BrushStage";
import { CompareSlider } from "./CompareSlider";
import styles from "./landing.module.css";

/** Just under the server's limits (try.server.ts: 12.6 M pixels, 12 MB). */
const UPLOAD_MAX_PIXELS = 12_000_000;
const UPLOAD_MAX_SIDE = 4000;
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Shrink a big photo in the browser before uploading it: the server refuses anything over
 * 12.6 megapixels, and 24 or 48 MP phone photos would otherwise use up a try each. The
 * server check stays the real limit; any failure here (no createImageBitmap, a format the
 * browser can't decode) sends the original file.
 */
async function shrinkForTry(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    try {
      const { width, height } = bmp;
      const scale = Math.min(
        1,
        UPLOAD_MAX_SIDE / Math.max(width, height),
        Math.sqrt(UPLOAD_MAX_PIXELS / (width * height)),
      );
      if (scale === 1 && file.size <= UPLOAD_MAX_BYTES) return file;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      // White first, so transparent PNGs don't turn black as a JPEG.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob) return file;
      return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
        type: "image/jpeg",
      });
    } finally {
      bmp.close();
    }
  } catch {
    return file;
  }
}

/** Seconds since `since` (a Date.now() timestamp), ticking while it's set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 250);
    const first = window.setTimeout(tick, 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** One free photo, no account: upload → cleaned preview in the same frame. */
export function TryIt({ limit }: { limit: number }) {
  const fetcher = useFetcher<typeof action>();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [aspect, setAspect] = useState<TryAspect>("1:1");
  /** The result whose brush reveal has played; the slider takes over after it. */
  const [revealed, setRevealed] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [keepBackground, setKeepBackground] = useState(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** "Try another photo" removed the focused button: put focus back on the drop zone. */
  const refocusDrop = useRef(false);

  const busy = preparing || fetcher.state !== "idle";
  const data = fetcher.data;
  const result =
    data && "result" in data && data.result.id !== dismissed ? data : null;
  const error = !busy && data && "error" in data ? data.error : null;
  const revealing =
    result !== null && preview !== null && revealed !== result.result.id;
  const elapsed = useElapsed(busy ? startedAt : null);
  const stageAspect: TryAspect = result ? result.result.aspect : aspect;
  const resultId = result?.result.id ?? null;
  const onRevealed = useCallback(() => setRevealed(resultId), [resultId]);

  /** The result whose heading has had focus (moved there once per result). */
  const focusedResult = useRef<string | null>(null);

  // After every commit, since each case depends on what has just been rendered:
  // - a new result replaces the controls (and the focused submit button): move focus to its
  //   heading, so keyboard and screen-reader users land on it;
  // - "Try another photo" removed the focused button: put focus back on the drop zone.
  // (An effect keyed on [resultId] didn't run when the fetcher's result arrived in testing.)
  useEffect(() => {
    if (resultId && focusedResult.current !== resultId && resultHeading.current) {
      focusedResult.current = resultId;
      resultHeading.current.focus({ preventScroll: true });
    } else if (refocusDrop.current && fileInput.current) {
      refocusDrop.current = false;
      fileInput.current.focus({ preventScroll: true });
    }
  });

  const choose = (next: File | null | undefined) => {
    if (!next || busy || revealing) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(URL.createObjectURL(next));
  };

  const reset = () => {
    refocusDrop.current = true;
    if (result) setDismissed(result.result.id);
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || busy || result) return;
    // Read the form now: the event's target is gone after the await.
    const form = new FormData(event.currentTarget);
    setPreparing(true);
    setStartedAt(Date.now());
    setKeepBackground(form.get("background") === "keep");
    void shrinkForTry(file)
      .then((photo) => {
        form.set("photo", photo);
        const sent = fetcher.submit(form, {
          method: "post",
          action: "/try",
          encType: "multipart/form-data",
        });
        // The fetcher is "submitting" from here on; its promise only settles once the
        // action has answered, so don't keep "Preparing…" up until then.
        setPreparing(false);
        return sent;
      })
      .finally(() => setPreparing(false));
  };

  const stageRatio = stageAspect === "4:5" ? "4 / 5" : "1 / 1";
  const working = busy || revealing;

  let stage: React.ReactNode;
  if (result && !revealing) {
    const r = result.result;
    // The before side is the upload itself, framed like the brush stage showed it (whole
    // photo on white), so nothing looks cropped at the handover. r.before is the fallback.
    stage = (
      <CompareSlider
        before={preview ?? r.before}
        after={r.after}
        alt="Your photo"
        label="Your photo"
        aspect={stageRatio}
        beforeFit="contain"
        demo
        demoFrom={0}
        demoTo={50}
      />
    );
  } else {
    stage = (
      <label
        className={[
          styles.drop,
          dragging ? styles.dropActive : "",
          preview ? styles.dropFilled : "",
          working ? styles.dropBusy : "",
        ].join(" ")}
        style={{ aspectRatio: stageRatio }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!working) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files?.[0]);
        }}
      >
        <input
          ref={fileInput}
          className={styles.srOnly}
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => choose(e.target.files?.[0])}
          disabled={working}
        />
        {preview && working ? (
          <BrushStage
            src={preview}
            aspect={stageAspect}
            after={revealing ? result?.result.after : null}
            onRevealed={onRevealed}
          />
        ) : preview ? (
          <img
            className={styles.dropPreview}
            src={preview}
            alt="Selected for cleaning"
          />
        ) : (
          <span className={styles.dropHint}>
            <span className={styles.canvasGuide} aria-hidden="true">
              <span className={styles.canvasTag}>
                {stageAspect} canvas · padded, never cropped
              </span>
            </span>
            <span className={styles.dropGlyph} aria-hidden="true" />
            <strong>Drop a product photo here</strong>
            <span>or click to choose · JPG, PNG or WebP · up to 12 MB</span>
          </span>
        )}
      </label>
    );
  }

  // Outside the <label>, so it isn't part of the file input's name. The live region is
  // always there and holds only the state, so screen readers hear each change once; the
  // visible pill, with its ticking clock, is hidden from them.
  const statusText = !working
    ? ""
    : revealing
      ? "Cleaned"
      : preparing
        ? "Preparing your photo…"
        : "Cleaning your photo…";
  const status = (
    <>
      <span className={styles.srOnly} role="status">
        {statusText}
      </span>
      {working && (
        <span className={styles.dropStatus} aria-hidden="true">
          <span className={styles.dropStatusDot} />
          {statusText}
          {!revealing && elapsed > 0 && (
            <span className={styles.dropClock}>{clock(elapsed)}</span>
          )}
        </span>
      )}
    </>
  );

  let aside: React.ReactNode;
  if (result) {
    const { result: r, remaining } = result;
    aside = (
      <div className={`${styles.tryAside} ${styles.tryAsideIn}`}>
        <h3 className={styles.tryTitle} ref={resultHeading} tabIndex={-1}>
          Here&apos;s your photo, cleaned.
        </h3>
        <p className={styles.tryText}>
          Full size is {r.width}×{r.height}. This is a free preview; your upload
          is deleted after 24 hours.
        </p>
        {r.notes.length > 0 && (
          <ul className={styles.tryNotes}>
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <div className={styles.ctaRow}>
          <a className={`${styles.btn} ${styles.btnPrimary}`} href="#ways">
            Clean your whole catalog
          </a>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={reset}
          >
            Try another photo
          </button>
        </div>
        <p className={styles.microcopy}>
          {remaining === null
            ? "Owner mode: unlimited tries."
            : remaining > 0
              ? `${remaining} free ${remaining === 1 ? "try" : "tries"} left today.`
              : "That was today's last free try."}{" "}
          Full-resolution downloads open with the web app; join the waitlist
          below.
        </p>
      </div>
    );
  } else {
    aside = (
      <div className={styles.tryControls}>
        <fieldset className={styles.segment} disabled={busy}>
          <legend>Canvas</legend>
          <label>
            <input
              type="radio"
              name="aspect"
              value="1:1"
              checked={aspect === "1:1"}
              onChange={() => setAspect("1:1")}
            />{" "}
            <span>Square 1:1</span>
          </label>
          <label>
            <input
              type="radio"
              name="aspect"
              value="4:5"
              checked={aspect === "4:5"}
              onChange={() => setAspect("4:5")}
            />{" "}
            <span>Portrait 4:5</span>
          </label>
        </fieldset>
        <fieldset className={styles.segment} disabled={busy}>
          <legend>Background</legend>
          <label>
            <input
              type="radio"
              name="background"
              value="white"
              defaultChecked
            />{" "}
            <span>Pure white</span>
          </label>
          <label>
            <input type="radio" name="background" value="keep" />{" "}
            <span>Keep mine</span>
          </label>
        </fieldset>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          type="submit"
          disabled={!file || busy}
        >
          {busy ? "Cleaning…" : "Clean my photo"}
        </button>
        {busy ? (
          <p className={styles.tryWait}>
            {keepBackground
              ? "We find the product, then centre it and pad it onto your canvas, keeping your background. "
              : "We find the product, cut it out and check the cut-out, then pad it onto your canvas. If a check fails, a stronger model takes over, so some photos take a little longer. "}
            Usually 10–20 seconds.
          </p>
        ) : error ? (
          <p className={`${styles.microcopy} ${styles.tryError}`} role="alert">
            {error}
          </p>
        ) : (
          <p className={styles.microcopy}>
            Free, no account · {limit} photos a day · uploads deleted after 24
            hours · <a href={`${PAGES.privacy}#website-data`}>Privacy</a>
          </p>
        )}
      </div>
    );
  }

  return (
    <form className={styles.tryForm} onSubmit={submit}>
      <div className={styles.tryStage}>
        {stage}
        {status}
      </div>
      {aside}
    </form>
  );
}
