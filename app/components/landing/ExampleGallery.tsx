import { useEffect, useRef, useState } from "react";
import { CompareSlider } from "./CompareSlider";
import { CATEGORY_ORDER, type Category, type Example } from "./examples";
import styles from "./landing.module.css";

/** Cards shown under "All" before "Show all": three full rows on desktop. */
const INITIAL = 9;

type Filter = Category | "All";

function ExampleCard({
  example,
  number,
  order,
}: {
  example: Example;
  /** Stable number in the full set, so a card keeps it under any filter. */
  number: number;
  /** Position in the current view, for the staggered entrance. */
  order: number;
}) {
  const note = example.flag
    ? { text: example.flag, className: styles.printNote }
    : example.redone
      ? {
          text: "Caught by our check · redone",
          className: `${styles.printNote} ${styles.printNoteOk}`,
        }
      : null;
  return (
    <figure
      className={styles.print}
      style={{ animationDelay: `${Math.min(order, 8) * 45}ms` }}
      tabIndex={-1}
    >
      <CompareSlider
        before={example.before}
        after={example.after}
        alt={example.alt}
        label={`No. ${String(number).padStart(2, "0")}`}
        selection={example.selection}
      />
      <figcaption className={styles.printMeta}>
        <span className={styles.printCat}>{example.category}</span>
        <h3 className={styles.printTitle}>{example.title}</h3>
        <p className={styles.printCaption}>{example.caption}</p>
        {note && (
          <a className={note.className} href="#quality">
            <span className={styles.printNoteDot} aria-hidden="true" />
            {note.text}
          </a>
        )}
      </figcaption>
    </figure>
  );
}

/** Category-filtered contact sheet of before/after pairs. */
export function ExampleGallery({ examples }: { examples: Example[] }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [expanded, setExpanded] = useState(false);
  const gallery = useRef<HTMLDivElement>(null);
  /** Cards visible before "Show all" (the CSS shows fewer on narrow screens). */
  const firstHidden = useRef<number | null>(null);

  // "Show all" disappears once clicked: move focus to the first card it revealed, so
  // keyboard users carry on from where they were.
  useEffect(() => {
    const index = firstHidden.current;
    if (!expanded || index === null) return;
    firstHidden.current = null;
    const card = gallery.current?.children[index];
    if (card instanceof HTMLElement) card.focus();
  }, [expanded]);

  const present = new Set(examples.map((e) => e.category));
  const chips: Filter[] = [
    "All",
    ...CATEGORY_ORDER.filter((c) => present.has(c)),
  ];
  const matching =
    filter === "All" ? examples : examples.filter((e) => e.category === filter);
  const shown =
    filter === "All" && !expanded ? matching.slice(0, INITIAL) : matching;

  return (
    <>
      <div
        className={styles.chips}
        role="group"
        aria-label="Filter examples by category"
      >
        {chips.map((c) => {
          const on = c === filter;
          return (
            <button
              key={c}
              type="button"
              className={`${styles.chip} ${on ? styles.chipOn : ""}`}
              aria-pressed={on}
              onClick={() => setFilter(c)}
            >
              {c}
            </button>
          );
        })}
      </div>

      {/* Keyed by filter so the cards deal in again on every change. Collapsed, the CSS
          trims the first nine to whole rows on narrower screens. */}
      <div
        className={styles.gallery}
        ref={gallery}
        key={filter}
        data-collapsed={shown.length < matching.length ? "" : undefined}
      >
        {shown.map((example, i) => (
          <ExampleCard
            key={example.slug}
            example={example}
            number={examples.indexOf(example) + 1}
            order={i}
          />
        ))}
      </div>

      {shown.length < matching.length && (
        <div className={styles.galleryMore}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => {
              const cards = Array.from(gallery.current?.children ?? []);
              const visible = cards.filter(
                (c) => c instanceof HTMLElement && c.offsetParent !== null,
              ).length;
              firstHidden.current = visible;
              setExpanded(true);
            }}
          >
            Show all {matching.length} examples
          </button>
        </div>
      )}
    </>
  );
}
