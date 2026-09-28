import { useEffect, useRef, useState } from "react";
import type { Picture } from "./examples";
import styles from "./landing.module.css";

/** `sizes` for a gallery card: one column on phones, two on tablets, three from 980 px. */
export const CARD_SIZES =
  "(max-width: 640px) calc(100vw - 52px), (max-width: 980px) calc(50vw - 60px), 340px";

interface Props {
  /** A page image with WebP variants, or a plain URL (the try-it upload and result). */
  before: Picture | string;
  after: Picture | string;
  alt: string;
  /** How wide the frame is shown, for picking a variant (default: a gallery card). */
  sizes?: string;
  /** "contain" shows the whole before image on white instead of filling the frame. */
  beforeFit?: "cover" | "contain";
  /** Frame label shown top-left, e.g. "01 / Sneakers". */
  label?: string;
  /** Sweep the handle once when the slider first scrolls into view. */
  demo?: boolean;
  /** Where the demo sweep starts and ends (percent of the frame shown as "before"). */
  demoFrom?: number;
  demoTo?: number;
  priority?: boolean;
  /** Frame shape, CSS aspect-ratio (default square). */
  aspect?: string;
  /** Product box in the "before" frame (percent), drawn as an animated selection. */
  selection?: { x: number; y: number; w: number; h: number };
}

/** An <img>, wrapped in <picture> with a WebP srcset when the image has variants. */
function Img({
  image,
  sizes,
  alt,
  className,
  priority,
}: {
  image: Picture | string;
  sizes: string;
  alt: string;
  className: string;
  priority: boolean;
}) {
  const img = (
    <img
      className={className}
      src={typeof image === "string" ? image : image.src}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      width={1000}
      height={1000}
    />
  );
  if (typeof image === "string") return img;
  return (
    <picture>
      <source type="image/webp" srcSet={image.srcSet} sizes={sizes} />
      {img}
    </picture>
  );
}

/**
 * Before/after comparison. The range input covers the whole frame, so it works
 * with mouse, touch and keyboard; the visible handle just follows it.
 */
export function CompareSlider({
  before,
  after,
  alt,
  label,
  demo = false,
  demoFrom = 88,
  demoTo = 38,
  priority = false,
  selection,
  aspect = "1 / 1",
  sizes = CARD_SIZES,
  beforeFit = "cover",
}: Props) {
  const [pos, setPos] = useState(demo ? demoFrom : 50);
  const frame = useRef<HTMLDivElement>(null);
  const touched = useRef(false);

  useEffect(() => {
    if (!demo || !frame.current) return;
    let raf = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // No sweep: just settle in the middle.
      raf = requestAnimationFrame(() => setPos(50));
      return () => cancelAnimationFrame(raf);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const start = performance.now();
        const from = demoFrom;
        const to = demoTo;
        const tick = (now: number) => {
          if (touched.current) return;
          const t = Math.min(1, (now - start) / 1600);
          const eased = 1 - Math.pow(1 - t, 3);
          setPos(from + (to - from) * eased);
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.5 },
    );
    observer.observe(frame.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [demo, demoFrom, demoTo]);

  return (
    <div
      className={styles.compare}
      ref={frame}
      style={{ "--pos": `${pos}%`, aspectRatio: aspect } as React.CSSProperties}
    >
      <Img
        image={after}
        sizes={sizes}
        alt={`${alt}, after`}
        className={styles.compareImg}
        priority={priority}
      />
      <div
        className={`${styles.compareBefore} ${beforeFit === "contain" ? styles.compareBeforeContain : ""}`}
      >
        <Img
          image={before}
          sizes={sizes}
          alt={`${alt}, before`}
          className={styles.compareImg}
          priority={priority}
        />
        {selection && (
          <svg className={styles.ants} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <rect
              x={selection.x}
              y={selection.y}
              width={selection.w}
              height={selection.h}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
      <span className={styles.compareDivider} aria-hidden="true">
        <span className={styles.compareKnob} />
      </span>
      {label && <span className={styles.compareLabel}>{label}</span>}
      <span className={`${styles.compareTag} ${styles.compareTagBefore}`}>Before</span>
      <span className={`${styles.compareTag} ${styles.compareTagAfter}`}>After</span>
      <input
        className={styles.compareRange}
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={pos}
        onChange={(e) => {
          touched.current = true;
          setPos(Number(e.target.value));
        }}
        aria-label={`Drag to compare ${alt} before and after`}
      />
    </div>
  );
}
