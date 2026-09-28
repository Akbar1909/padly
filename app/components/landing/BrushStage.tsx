import { useEffect, useId, useMemo, useRef, useState } from "react";
import styles from "./landing.module.css";

export type TryAspect = "1:1" | "4:5";

interface Props {
  /** The photo being cleaned (object URL of the upload). */
  src: string;
  /** Canvas shape: the stage is 100 × 100 or 100 × 125 viewBox units. */
  aspect: TryAspect;
  /** The cleaned image. Once it has loaded, one brush stroke paints it in over `src`. */
  after?: string | null;
  /** Called once the reveal has finished (or at once if `after` can't be loaded). */
  onRevealed?: () => void;
}

const W = 100;
/** Overshoot past the frame's edge, so the brush turns round out of sight. */
const OVERSHOOT = 14;
/** Cleaning: brush width, its speed (viewBox units per ms) and how many passes the path has. */
const CLEAN_SW = 22;
const SPEED = 0.125;
/** About 90 s of passes, the try's longest wait; after that the brush repeats them. */
const PASSES = 64;
/**
 * The wet part of the trail right behind the brush, as [length, opacity] windows ending at
 * the brush: overlapping, so the wash is strongest at the brush and tapers off behind it.
 */
const FRESH: ReadonlyArray<readonly [number, number]> = [
  [20, 0.6],
  [42, 0.5],
  [72, 0.45],
];
/** The reveal: one quick stroke that paints the cleaned image in. */
const REVEAL_MS = 1200;
const PARTICLES = 14;

/**
 * Bristle streaks drawn alongside the main stroke, as [offset, width, opacity] in fractions
 * of the stroke width: the outer ones give the trail a fibrous edge, the inner ones the
 * lighter streaks inside it.
 */
const STREAKS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.56, 0.025, 0.55],
  [-0.47, 0.035, 0.8],
  [-0.33, 0.03, 0.9],
  [-0.18, 0.05, 0.7],
  [-0.04, 0.025, 0.9],
  [0.11, 0.045, 0.75],
  [0.25, 0.03, 0.9],
  [0.39, 0.04, 0.8],
  [0.5, 0.03, 0.7],
  [0.58, 0.02, 0.5],
];

/** Hairs at the edge of a brush trail behind its centre: lag per unit of offset. */
const EDGE_LAG = 9;

/** Small seeded PRNG (mulberry32), so the wandering path is the same on every render. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The cleaning path: passes across the frame at wandering heights (a random walk, never a
 * top-to-bottom sweep), each slightly diagonal, turning outside the frame. It never "finishes":
 * nothing about it says how far along the job is.
 */
function wanderPath(h: number, passes: number): string {
  const rand = seeded(0x5eed + h);
  const lo = 8;
  const hi = h - 8;
  let y = h * 0.42;
  const parts: string[] = [];
  for (let i = 0; i < passes; i++) {
    const ltr = i % 2 === 0;
    const x0 = ltr ? -OVERSHOOT : W + OVERSHOOT;
    const x1 = ltr ? W + OVERSHOOT : -OVERSHOOT;
    const drift = (rand() - 0.5) * 14;
    let y1 = y + drift;
    if (y1 < lo || y1 > hi) y1 = y - drift;
    if (i === 0) parts.push(`M${x0} ${y.toFixed(2)}`);
    const w = (rand() - 0.5) * 6;
    const third = (x1 - x0) / 3;
    parts.push(
      `C${x0 + third} ${(y + (y1 - y) / 3 - w).toFixed(2)} ${x0 + 2 * third} ${(y + (2 * (y1 - y)) / 3 + w).toFixed(2)} ${x1} ${y1.toFixed(2)}`,
    );
    // Step to the next pass's height, outside the frame.
    let step = (12 + rand() * 22) * (rand() < 0.5 ? -1 : 1);
    if (y1 + step < lo || y1 + step > hi) step = -step;
    const next = Math.min(hi, Math.max(lo, y1 + step));
    const bx = ltr ? x1 + Math.abs(step) * 0.6 : x1 - Math.abs(step) * 0.6;
    parts.push(`C${bx} ${y1.toFixed(2)} ${bx} ${next.toFixed(2)} ${x1} ${next.toFixed(2)}`);
    y = next;
  }
  return parts.join(" ");
}

/** Rows across the frame, left to right then back, turning outside it. */
function sweepPath(h: number, rows: number, wobble: number): string {
  const step = h / rows;
  const parts: string[] = [];
  for (let i = 0; i < rows; i++) {
    const y = step * (i + 0.5);
    const ltr = i % 2 === 0;
    const x0 = ltr ? -OVERSHOOT : W + OVERSHOOT;
    const x1 = ltr ? W + OVERSHOOT : -OVERSHOOT;
    if (i === 0) {
      parts.push(`M${x0} ${y}`);
    } else {
      const bx = ltr ? x0 - step * 0.75 : x0 + step * 0.75;
      parts.push(`C${bx} ${y - step} ${bx} ${y} ${x0} ${y}`);
    }
    const w = ltr ? wobble : -wobble;
    const third = (x1 - x0) / 3;
    parts.push(
      `C${x0 + third} ${y - w} ${x0 + 2 * third} ${y + w} ${x1} ${y}`,
    );
  }
  return parts.join(" ");
}

const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Give every path in a stroke group one dash as long as the path, followed by a longer gap,
 * so the dash offset alone decides how much of it is drawn. Real lengths rather than
 * pathLength, which older WebKit ignores for dashes.
 */
function initDash(group: SVGGElement | null, length: number) {
  if (!group) return;
  for (const path of Array.from(group.children)) {
    path.setAttribute("stroke-dasharray", `${length} ${length * 2}`);
    path.setAttribute("stroke-dashoffset", String(length));
  }
}

/** Show, on each path of a group, only the `length` units just behind `at` (see FRESH). */
function setWindow(group: SVGGElement | null, at: number, total: number) {
  if (!group) return;
  for (const path of Array.from(group.children)) {
    const len = Number(path.getAttribute("data-len") ?? 0);
    path.setAttribute("stroke-dasharray", `${len} ${total * 3}`);
    path.setAttribute("stroke-dashoffset", (len - at).toFixed(2));
  }
}

/**
 * Draw the first `p` of each path. Each streak trails the centre by its data-lag (viewBox
 * units), so the stroke's front is rounded like a real brush's instead of a flat cut.
 */
function setDash(group: SVGGElement | null, p: number, length: number) {
  if (!group) return;
  for (const path of Array.from(group.children)) {
    const lag = Number(path.getAttribute("data-lag") ?? 0) / length;
    const q = p >= 1 ? 1 : Math.max(0, p - lag);
    path.setAttribute("stroke-dashoffset", (length * (1 - q)).toFixed(2));
  }
}

function place(
  el: SVGGElement | null,
  x: number,
  y: number,
  dir: number,
  scale: number,
  tilt: number,
  opacity: number,
) {
  if (!el) return;
  el.setAttribute(
    "transform",
    `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${dir * scale} ${scale}) rotate(${tilt.toFixed(2)})`,
  );
  el.style.opacity = opacity.toFixed(3);
}

/** Bristle hairs of the brush head: [y at the ferrule, y at the tip, opacity]. */
const HAIRS: ReadonlyArray<readonly [number, number, number]> = [
  [-9.2, -11.4, 0.35],
  [-7.4, -9.1, 0.22],
  [-5.3, -6.6, 0.3],
  [-3.1, -3.9, 0.2],
  [-1, -1.2, 0.3],
  [1.2, 1.5, 0.22],
  [3.3, 4.1, 0.3],
  [5.5, 6.8, 0.2],
  [7.5, 9.3, 0.3],
  [9.2, 11.4, 0.35],
];

/**
 * A wide flat brush seen from above, travelling towards +x: the bristles (centred on the
 * origin) trail behind a metal ferrule, and the lacquered handle leads, tilted up.
 */
function BrushHead({ id }: { id: string }) {
  return (
    <>
      <ellipse cx={-3} cy={0} rx={21} ry={17} fill={`url(#${id}-glow)`} />
      <g filter={`url(#${id}-shadow)`}>
        {/* bristles: a soft fan with a ragged, splayed tip edge */}
        <path
          d="M1.2 -10.2 C-2.6 -10.6 -6.2 -11.2 -8.8 -12 L-9.8 -10.4 L-9.1 -8.6 L-10.3 -6.4 L-9.4 -4.3 L-10.5 -2.1 L-9.6 0 L-10.5 2.1 L-9.4 4.3 L-10.3 6.4 L-9.1 8.6 L-9.8 10.4 L-8.8 12 C-6.2 11.2 -2.6 10.6 1.2 10.2 Z"
          fill={`url(#${id}-bristle)`}
        />
        <g stroke="#7a6a52" strokeWidth={0.2} strokeLinecap="round">
          {HAIRS.map(([y0, y1, o]) => (
            <line
              key={y0}
              x1={0.8}
              y1={y0}
              x2={-9.3}
              y2={y1}
              strokeOpacity={o}
            />
          ))}
        </g>
        {/* ferrule, crimped where it narrows onto the handle */}
        <path
          d="M1 -10.6 H5.4 C7.4 -10.6 8.6 -7.6 9.8 -4.4 V4.4 C8.6 7.6 7.4 10.6 5.4 10.6 H1 Z"
          fill={`url(#${id}-ferrule)`}
        />
        <path
          d="M3.2 -10.4 V10.4 M4.4 -10.4 V10.4"
          stroke="#6d665b"
          strokeOpacity={0.45}
          strokeWidth={0.28}
        />
        <path
          d="M1.8 -9.8 V9.8"
          stroke="#fff"
          strokeOpacity={0.7}
          strokeWidth={0.45}
        />
        {/* handle */}
        <g transform="translate(9.2 0) rotate(-34)">
          <path
            d="M0 -3.4 C6 -3.1 12.5 -2.6 17.6 -2.2 C20.1 -2 20.1 2 17.6 2.2 C12.5 2.6 6 3.1 0 3.4 Z"
            fill={`url(#${id}-handle)`}
          />
          <path
            d="M1.4 -1.8 C7 -1.6 12 -1.3 16.8 -1"
            fill="none"
            stroke="#fff"
            strokeOpacity={0.45}
            strokeWidth={0.5}
            strokeLinecap="round"
          />
          <circle cx={17.2} cy={0} r={0.75} fill="#16130f" fillOpacity={0.55} />
        </g>
      </g>
    </>
  );
}

/** The main stroke plus its bristle streaks, all sharing one path. */
function Stroke({
  d,
  width,
  body,
}: {
  d: string;
  width: number;
  /** Mask value of the stroke's body (the streaks are brighter). */
  body: string;
}) {
  // Nothing drawn until the animation sets real dash lengths (initDash).
  const common = { d, strokeDasharray: "0 100000" } as const;
  return (
    <>
      <path {...common} stroke={body} strokeWidth={width} data-lag={0} />
      {STREAKS.map(([dy, w, o]) => (
        <path
          key={dy}
          {...common}
          data-lag={(Math.abs(dy) * EDGE_LAG * width) / CLEAN_SW}
          transform={`translate(0 ${(dy * width).toFixed(2)})`}
          stroke="#fff"
          strokeOpacity={o}
          strokeWidth={Math.max(0.3, w * width)}
        />
      ))}
    </>
  );
}

/**
 * Decorative "cleaning" stage for the try-it wait: a brush wanders back and forth over the
 * photo. Right behind it the photo looks freshly washed; that fades to a light veil which
 * stays, so the photo never snaps back and never looks "done". It shows no progress: the
 * brush just keeps going until the result arrives. Then a single brush stroke paints the
 * cleaned image in over the veil (about 1.2 s) and `onRevealed` fires. With reduced motion
 * there is no brushing: the photo sits still and the result cross-fades in.
 */
export function BrushStage({ src, aspect, after, onRevealed }: Props) {
  const h = aspect === "4:5" ? 125 : 100;
  const id = `brush${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [reduce] = useState(prefersReducedMotion);
  const [afterReady, setAfterReady] = useState(false);

  const cleanGeo = useRef<SVGPathElement>(null);
  const revealGeo = useRef<SVGPathElement>(null);
  const trail = useRef<SVGGElement>(null);
  const fresh = useRef<SVGGElement>(null);
  const freshWash = useRef<SVGGElement>(null);
  const revealMask = useRef<SVGGElement>(null);
  const band = useRef<SVGGElement>(null);
  const brush = useRef<SVGGElement>(null);
  const revealBrush = useRef<SVGGElement>(null);
  const sparks = useRef<SVGGElement>(null);
  const revealAt = useRef<number | null>(null);
  const done = useRef(onRevealed);

  const revealRows = aspect === "4:5" ? 5 : 4;
  const revealSW = h / revealRows + 8;
  const cleanD = useMemo(() => wanderPath(h, PASSES), [h]);
  const revealD = sweepPath(h, revealRows, 3.5);

  useEffect(() => {
    done.current = onRevealed;
  }, [onRevealed]);

  // Load the cleaned image before painting it in; a failed load skips the reveal.
  useEffect(() => {
    if (!after) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setAfterReady(true);
    };
    img.onerror = () => {
      if (!cancelled) done.current?.();
    };
    img.src = after;
    return () => {
      cancelled = true;
    };
  }, [after]);

  // Reduced motion: a plain cross-fade (CSS), then hand over.
  useEffect(() => {
    if (!afterReady) return;
    if (!reduce) {
      revealAt.current = performance.now();
      return;
    }
    const timer = window.setTimeout(() => done.current?.(), 520);
    return () => window.clearTimeout(timer);
  }, [afterReady, reduce]);

  useEffect(() => {
    if (reduce) return;
    const cleanPath = cleanGeo.current;
    const revealPath = revealGeo.current;
    if (!cleanPath || !revealPath) return;
    const cleanLen = cleanPath.getTotalLength();
    const revealLen = revealPath.getTotalLength();
    const cleanMs = cleanLen / SPEED;
    const revealScale = (revealSW / CLEAN_SW) * 0.9;
    initDash(trail.current, cleanLen);
    initDash(revealMask.current, revealLen);

    const pool = Array.from({ length: PARTICLES }, () => ({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      born: -1,
      life: 1,
    }));
    const dots = Array.from(sparks.current?.children ?? []);
    let nextSpark = 0;
    let dir = 1;
    let revealDir = 1;
    let handedOver = false;
    let handTimer = 0;
    let last = performance.now();
    const t0 = last;
    let raf = 0;

    const direction = (path: SVGPathElement, at: number, len: number, prev: number) => {
      const a = path.getPointAtLength(Math.max(0, at - 0.4));
      const b = path.getPointAtLength(Math.min(len, at + 0.4));
      const dx = b.x - a.x;
      return Math.abs(dx) < 0.02 ? prev : Math.sign(dx);
    };

    const spark = (now: number, x: number, y: number, d: number, spread: number) => {
      if (now < nextSpark || x < 0 || x > W) return;
      nextSpark = now + 55;
      const p = pool.find((q) => q.born < 0 || now - q.born > q.life);
      if (!p) return;
      p.x = x - d * (4 + Math.random() * 6);
      p.y = y + (Math.random() - 0.5) * spread;
      p.vx = -d * (0.004 + Math.random() * 0.012);
      p.vy = -(0.004 + Math.random() * 0.012);
      p.born = now;
      p.life = 500 + Math.random() * 450;
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const rStart = revealAt.current;
      const t = now - t0;
      const wobble = Math.sin(t / 170) * 3;

      if (rStart === null) {
        // Cleaning: the brush keeps wandering; the veil it leaves stays. Past the end of the
        // path (about 90 s) it goes round again over the veil, out of sight at the join.
        const p = Math.min(1, t / cleanMs);
        const at = (t % cleanMs) * SPEED;
        const pt = cleanPath.getPointAtLength(at);
        dir = direction(cleanPath, at, cleanLen, dir);
        setDash(trail.current, p, cleanLen);
        setWindow(fresh.current, at, cleanLen);
        place(brush.current, pt.x, pt.y, dir, 1, -6 + wobble, 1);
        place(band.current, 0, pt.y, 1, 1, 0, 1);
        spark(now, pt.x, pt.y, dir, CLEAN_SW);
      } else {
        // The reveal: the brush and its wet trail fade, the veil stays under the photo, and
        // one wide stroke paints the result in over it.
        const since = now - rStart;
        const k = Math.min(1, since / REVEAL_MS);
        const e = easeInOut(k);
        const at = e * revealLen;
        const pt = revealPath.getPointAtLength(at);
        revealDir = direction(revealPath, at, revealLen, revealDir);
        setDash(revealMask.current, e, revealLen);
        const out = Math.max(0, 1 - since / 220);
        if (freshWash.current) freshWash.current.style.opacity = out.toFixed(3);
        if (brush.current) brush.current.style.opacity = out.toFixed(3);
        place(revealBrush.current, pt.x, pt.y, revealDir, revealScale, -8 + wobble, k < 1 ? 1 : 0);
        place(band.current, 0, pt.y, 1, revealScale, 0, k < 1 ? 1 : 0);
        if (k < 1) spark(now, pt.x, pt.y, revealDir, revealSW);
        if (k >= 1 && !handedOver) {
          handedOver = true;
          handTimer = window.setTimeout(() => done.current?.(), 160);
        }
      }

      pool.forEach((p, i) => {
        const dot = dots[i];
        if (!dot) return;
        const age = now - p.born;
        if (p.born < 0 || age > p.life) {
          dot.setAttribute("opacity", "0");
          return;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.00002 * dt;
        dot.setAttribute("cx", p.x.toFixed(2));
        dot.setAttribute("cy", p.y.toFixed(2));
        dot.setAttribute("opacity", (0.9 * (1 - age / p.life)).toFixed(3));
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(handTimer);
    };
  }, [reduce, cleanD, revealSW]);

  const box = { x: 0, y: 0, width: W, height: h };

  return (
    <svg
      className={styles.brushStage}
      viewBox={`0 0 ${W} ${h}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* the veil the brush leaves: about a fifth of the way to warm white, so the
            product under it still looks like itself */}
        <filter id={`${id}-wash`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0.78" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="0.78" intercept="0.22" />
            <feFuncG type="linear" slope="0.78" intercept="0.218" />
            <feFuncB type="linear" slope="0.78" intercept="0.211" />
          </feComponentTransfer>
        </filter>
        {/* right behind the brush: freshly washed */}
        <filter id={`${id}-wet`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0.3" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="0.4" intercept="0.6" />
            <feFuncG type="linear" slope="0.4" intercept="0.595" />
            <feFuncB type="linear" slope="0.4" intercept="0.576" />
          </feComponentTransfer>
        </filter>
        {/* softens the mask so the streaks read as bristle marks, not scan lines */}
        <filter id={`${id}-soft`} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="0.45" />
        </filter>
        <filter id={`${id}-shadow`} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow
            dx="0.4"
            dy="1.4"
            stdDeviation="1.1"
            floodColor="#16130f"
            floodOpacity="0.38"
          />
        </filter>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="#fff" stopOpacity="0.6" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.14" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-bristle`} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#fffaf0" />
          <stop offset="1" stopColor="#e6d9bd" />
        </linearGradient>
        <linearGradient id={`${id}-ferrule`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4f1ea" />
          <stop offset="0.45" stopColor="#b9b2a6" />
          <stop offset="0.55" stopColor="#d9d3c8" />
          <stop offset="1" stopColor="#8a8377" />
        </linearGradient>
        <linearGradient id={`${id}-handle`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff7a45" />
          <stop offset="1" stopColor="#d9440c" />
        </linearGradient>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.2" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-trail`}>
          <g
            ref={trail}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${id}-soft)`}
          >
            <Stroke d={cleanD} width={CLEAN_SW} body="#cfcfcf" />
          </g>
        </mask>
        <mask id={`${id}-fresh`}>
          <g
            ref={fresh}
            fill="none"
            stroke="#fff"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${id}-soft)`}
          >
            {FRESH.map(([len, o]) => (
              <path
                key={len}
                d={cleanD}
                data-len={len}
                strokeWidth={CLEAN_SW * 0.92}
                strokeOpacity={o}
                strokeDasharray="0 100000"
              />
            ))}
          </g>
        </mask>
        <mask id={`${id}-reveal`}>
          <g
            ref={revealMask}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${id}-soft)`}
          >
            <Stroke d={revealD} width={revealSW} body="#fff" />
          </g>
        </mask>
      </defs>

      {/* Geometry only: the brush follows these. */}
      <path ref={cleanGeo} d={cleanD} fill="none" stroke="none" />
      <path ref={revealGeo} d={revealD} fill="none" stroke="none" />

      <image {...box} href={src} preserveAspectRatio="xMidYMid meet" />
      {!reduce && (
        <>
          <g mask={`url(#${id}-trail)`}>
            <image
              {...box}
              href={src}
              preserveAspectRatio="xMidYMid meet"
              filter={`url(#${id}-wash)`}
            />
          </g>
          <g ref={freshWash} mask={`url(#${id}-fresh)`}>
            <image
              {...box}
              href={src}
              preserveAspectRatio="xMidYMid meet"
              filter={`url(#${id}-wet)`}
            />
          </g>
        </>
      )}
      {after && afterReady && (
        <image
          {...box}
          href={after}
          preserveAspectRatio="xMidYMid slice"
          className={reduce ? styles.brushFadeIn : undefined}
          mask={reduce ? undefined : `url(#${id}-reveal)`}
        />
      )}
      {!reduce && (
        <>
          <g ref={band} opacity={0}>
            <rect x={0} y={-15} width={W} height={30} fill={`url(#${id}-band)`} />
            <line
              className={styles.brushAnts}
              x1={0}
              x2={W}
              y1={0}
              y2={0}
              stroke="#ff5a1f"
              strokeOpacity={0.55}
              strokeWidth={0.35}
              strokeDasharray="1.6 1.2"
            />
          </g>
          <g ref={sparks} fill="#fffdf8" stroke="#16130f" strokeOpacity={0.18} strokeWidth={0.12}>
            {Array.from({ length: PARTICLES }, (_, i) => (
              <circle key={i} r={0.45 + (i % 4) * 0.25} cx={-10} cy={-10} opacity={0} />
            ))}
          </g>
          <g ref={brush} opacity={0}>
            <BrushHead id={id} />
          </g>
          <g ref={revealBrush} opacity={0}>
            <BrushHead id={id} />
          </g>
        </>
      )}
    </svg>
  );
}
