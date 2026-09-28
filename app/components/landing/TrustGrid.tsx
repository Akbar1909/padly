import { PAGES } from "../../lib/brand";
import { ERASURE_WINDOW } from "../legal/copy";
import { EXAMPLES } from "./examples";
import styles from "./landing.module.css";

interface Tile {
  tag: string;
  title: string;
  body: string;
  icon: string;
  /** A short, checkable fact pinned to the tile's foot. */
  fact?: string;
  note?: { text: string; href?: string; link?: string };
  variant?: "lead";
}

export interface PackPrice {
  credits: number;
  price: number;
}

const tiles = (packs: PackPrice[]): Tile[] => [
  {
    tag: "Control",
    title: "Nothing changes until you approve.",
    body: "Every image waits in review with its before, after and cut-out mask. Apply what you like, reject the rest. Flagged images are never approved in bulk.",
    icon: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z",
    variant: "lead",
  },
  {
    tag: "Backups",
    title: "Originals backed up. One-click restore.",
    body: "Each original is saved before it's touched. Restore one image or a whole job, free, while the app is installed.",
    icon: "M4 12a8 8 0 108-8M4 4v8h8",
    fact: "Restores cost 0 credits",
  },
  {
    tag: "Credits",
    title: "Pay only for images you apply.",
    body: "Previews, rejected and failed images cost nothing. Credits are reserved, not spent, until you apply.",
    icon: "M12 3v18M17 7H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
    fact: "1 credit per applied image (+1 with AI upscaling)",
  },
  {
    tag: "Billing",
    title: "Billed through Shopify.",
    body: "One-time credit packs on your Shopify invoice, in USD. No card to enter, no subscription.",
    icon: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
    fact:
      packs.length > 0
        ? `Packs from $${Math.min(...packs.map((p) => p.price))} USD`
        : undefined,
  },
  {
    tag: "Background",
    title: "Close the tab. We keep going.",
    body: "Jobs run on our servers with progress you can check any time. When one is ready for review, a notice is waiting in the app.",
    icon: "M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    fact: "Notices on the app's Home page",
  },
  {
    tag: "Data",
    title: "Stored in the EU. Erased when you leave.",
    body: `Your store's data, images and backups are kept on our server in the Netherlands, and erased ${ERASURE_WINDOW}.`,
    icon: "M12 21s-7-6.2-7-11a7 7 0 1114 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
    note: {
      text: "Harder cut-outs and some AI upscales are processed in the US, pixels only.",
      href: `${PAGES.privacy}#transfers`,
      link: "Details",
    },
  },
  {
    tag: "Access",
    title: "Products and files. Nothing else.",
    body: "The app never reads your orders or customers, and your images are never used to train AI models.",
    icon: "M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 017 0v3",
    fact: "Scopes: products, files",
  },
];

/** Befores of four busy scenes from the gallery's first rows (small thumbnails). */
const MESSY = ["rattan-chair", "copper-teapot", "tassel-earrings", "polka-dot-dress"]
  .map((slug) => EXAMPLES.find((e) => e.slug === slug))
  .filter((e) => e !== undefined);

function Glyph({ d }: { d: string }) {
  return (
    <span className={styles.trustIcon} aria-hidden="true">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </span>
  );
}

/** Why a merchant can run this on a live store: only facts the code keeps. */
export function TrustGrid({ packs }: { packs: PackPrice[] }) {
  return (
    <div className={styles.trust}>
      {tiles(packs).map((t) => (
        <article
          key={t.tag}
          className={`${styles.trustTile} ${t.variant === "lead" ? styles.trustLead : ""}`}
        >
          <div className={styles.trustTop}>
            <Glyph d={t.icon} />
            <span className={styles.trustTag}>{t.tag}</span>
          </div>
          <h3 className={styles.trustTitle}>{t.title}</h3>
          <p className={styles.trustBody}>{t.body}</p>
          {t.variant === "lead" && (
            <div className={styles.trustDemo} aria-hidden="true">
              <span className={styles.trustChip}>Before</span>
              <span className={styles.trustChip}>After</span>
              <span className={styles.trustChip}>Mask</span>
              <span className={`${styles.trustChip} ${styles.trustChipGo}`}>
                Apply
              </span>
              <span className={styles.trustChip}>Reject</span>
            </div>
          )}
          {t.fact && <p className={styles.trustFact}>{t.fact}</p>}
          {t.note && (
            <p className={styles.trustNote}>
              {t.note.text}{" "}
              {t.note.href && <a href={t.note.href}>{t.note.link}</a>}
            </p>
          )}
        </article>
      ))}
      <article className={`${styles.trustTile} ${styles.trustWide}`}>
        <div>
          <div className={styles.trustTop}>
            <Glyph d="M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4" />
            <span className={styles.trustTag}>Proof</span>
          </div>
          <h3 className={styles.trustTitle}>Works on messy, real photos.</h3>
          <p className={styles.trustBody}>
            Park benches, striped cloth, hard sunlight, clear glass. See{" "}
            {EXAMPLES.length} real examples, run through the same pipeline and
            not retouched.
          </p>
          <a className={styles.trustLink} href="#examples">
            See the examples <span aria-hidden="true">→</span>
          </a>
        </div>
        <div className={styles.trustFan} aria-hidden="true">
          {MESSY.map((e) => (
            <picture key={e.slug}>
              <source
                type="image/webp"
                srcSet={e.before.srcSet}
                sizes="(max-width: 640px) 76px, 132px"
              />
              <img
                src={e.before.src}
                alt=""
                loading="lazy"
                decoding="async"
                width={1000}
                height={1000}
              />
            </picture>
          ))}
        </div>
      </article>
    </div>
  );
}
