import { STORY } from "./examples";
import styles from "./landing.module.css";

const FRAMES = [
  {
    src: STORY.original,
    alt: "A white candle in a clear jar on a wooden table, in front of a bright window, its lid leaning against it",
    step: "01",
    title: "The original",
    body: "A white candle in a clear jar, lit from a bright window behind. The jar is almost the same colour as the background: the kind of photo that fools a fast model.",
    stamp: null,
  },
  {
    src: STORY.rejected,
    alt: "The rejected first attempt: only the jar's lid was cut out, enlarged and blurry",
    step: "02",
    title: "First attempt: rejected",
    body: "Our fast model found only the lid. Run again on a mirrored copy of the photo, it changed 79% of its cut-out, against a 1.5% limit, so the check rejected it. A second, zoomed-in try was rejected too.",
    stamp: "rejected",
  },
  {
    src: STORY.final,
    alt: "The final result: the candle jar and its lid on pure white",
    step: "03",
    title: "Final: passed",
    body: "The photo went to a stronger model. It returned the jar and the lid, which passed the edge, coverage and piece checks with no flag. Runs like this take longer than a normal photo.",
    stamp: "passed",
  },
] as const;

const RULES = [
  {
    title: "Every cut-out is checked automatically",
    body: "Our fast model's cut-out is re-run on a mirrored copy of the photo; if the two disagree, it's rejected. We also check the edges, that no inner part was dropped, and that labels aren't cut through.",
  },
  {
    title: "Doubtful ones get a stronger model",
    body: "A rejected cut-out is redone by a stronger model before you see anything, at no extra credit, or flagged for you if it can't be.",
  },
  {
    title: "Still unsure? It's flagged for you",
    body: "Uncertain edges like glass, hair or fine chains, or a product in several pieces, get a flag. Flagged images are never approved in bulk.",
  },
  {
    title: "Nothing changes until you approve",
    body: "You see every result next to its original first. Your store only changes when you apply, and the original is backed up before it does.",
  },
];

/** "How we check every photo": one real rejected-then-redone run, then the rules. */
export function QualityStory() {
  return (
    <section className={`${styles.section} ${styles.quality}`} id="quality">
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <div>
            <span className={styles.kicker}>How we check every photo</span>
            <h2 className={styles.h2}>
              Most bad cut-outs <em>never reach your review.</em>
            </h2>
          </div>
          <p className={styles.sectionIntro}>
            A real run, frame by frame. Every cut-out is checked automatically
            before you see it; the doubtful ones are redone or flagged, and you
            still approve each result. This photo needed it.
          </p>
        </div>

        <ol className={styles.storyStrip}>
          {FRAMES.map((f) => (
            <li className={styles.storyStep} key={f.step}>
              <div
                className={`${styles.storyFrame} ${f.stamp === "rejected" ? styles.storyFrameRejected : ""}`}
              >
                <picture>
                  <source
                    type="image/webp"
                    srcSet={f.src.srcSet}
                    sizes="(max-width: 760px) 82vw, (max-width: 980px) 30vw, 340px"
                  />
                  <img
                    src={f.src.src}
                    alt={f.alt}
                    loading="lazy"
                    decoding="async"
                    width={1000}
                    height={1000}
                  />
                </picture>
                <span className={styles.storyNum}>{f.step}</span>
                {f.stamp === "rejected" && (
                  <span className={`${styles.stamp} ${styles.stampRejected}`}>
                    Rejected
                    <small>mirrored pass: 79% changed · limit 1.5%</small>
                  </span>
                )}
                {f.stamp === "passed" && (
                  <span className={`${styles.stamp} ${styles.stampPassed}`}>
                    Passed
                    <small>stronger model · no flags</small>
                  </span>
                )}
              </div>
              <h3 className={styles.storyTitle}>{f.title}</h3>
              <p className={styles.storyBody}>{f.body}</p>
            </li>
          ))}
        </ol>
        <p className={styles.storyNote}>
          All three frames are real output of our pipeline, not retouched. The
          middle one is what the rejected attempt would have produced.
        </p>

        <ol className={styles.rules}>
          {RULES.map((r, i) => (
            <li className={styles.rule} key={r.title}>
              <span className={styles.ruleNum}>{i + 1}</span>
              <h3>{r.title}</h3>
              <p>{r.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
