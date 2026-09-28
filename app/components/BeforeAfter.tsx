import { useState } from "react";

interface Props {
  before: string | null;
  after: string | null;
  mask?: string | null;
  showMask?: boolean;
  /** CSS aspect-ratio of the output canvas, e.g. "1 / 1" or "4 / 5". */
  aspectRatio: string;
  label: string;
}

const checker =
  "repeating-conic-gradient(#f1f1f1 0% 25%, #ffffff 0% 50%) 50% / 16px 16px";

/**
 * Drag to compare. "Before" (the original, with the optional mask overlay
 * tinting what gets removed) is on the left of the handle, "after" on the right.
 */
export function BeforeAfter({ before, after, mask, showMask, aspectRatio, label }: Props) {
  const [pos, setPos] = useState(50);
  const img: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    pointerEvents: "none",
  };
  const tag: React.CSSProperties = {
    position: "absolute",
    top: 6,
    padding: "1px 6px",
    borderRadius: 4,
    fontSize: 11,
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    pointerEvents: "none",
  };

  return (
    <div
      style={{
        position: "relative",
        aspectRatio,
        width: "100%",
        overflow: "hidden",
        borderRadius: 8,
        background: checker,
        border: "1px solid #e3e3e3",
      }}
    >
      {after && <img src={after} alt={`${label}, after`} style={img} loading="lazy" />}
      <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${100 - pos}% 0 0)`, background: checker }}>
        {before && <img src={before} alt={`${label}, before`} style={img} loading="lazy" />}
        {showMask && mask && <img src={mask} alt="" style={img} loading="lazy" />}
      </div>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `calc(${pos}% - 1px)`,
          width: 2,
          background: "#fff",
          boxShadow: "0 0 0 1px rgba(0,0,0,0.25)",
          pointerEvents: "none",
        }}
      />
      <span style={{ ...tag, left: 6 }}>Before</span>
      <span style={{ ...tag, right: 6 }}>After</span>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label={`Compare before and after for ${label}`}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          margin: 0,
          opacity: 0,
          cursor: "ew-resize",
        }}
      />
    </div>
  );
}
