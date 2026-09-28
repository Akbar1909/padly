import type { ReactNode } from "react";
import type { LinksFunction, MetaDescriptor } from "react-router";

import { BRAND, PAGES } from "../../lib/brand";
import styles from "./legal.module.css";

/** Same typefaces as the landing page (listed as a third party in the privacy policy). */
export const legalLinks: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap",
  },
];

/** Title, description, Open Graph and canonical tags for a public page. */
export function legalMeta(
  title: string,
  description: string,
  path: string,
): MetaDescriptor[] {
  const full = `${title} · ${BRAND.name}`;
  return [
    { title: full },
    { name: "description", content: description },
    { property: "og:title", content: full },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: BRAND.name },
    { property: "og:url", content: BRAND.site + path },
    { property: "og:image", content: `${BRAND.site}/brand/og-1200x630.png` },
    { name: "twitter:card", content: "summary_large_image" },
    { tagName: "link", rel: "canonical", href: BRAND.site + path },
  ];
}

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

const NAV = [
  { href: PAGES.support, label: "Support" },
  { href: PAGES.privacy, label: "Privacy" },
  { href: PAGES.terms, label: "Terms" },
];

/** Header, footer and page chrome shared by the public pages. */
export function SiteShell({
  current,
  children,
}: {
  current?: string;
  children: ReactNode;
}) {
  const year = new Date().getFullYear();
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#content">
        Skip to content
      </a>
      <header className={styles.nav}>
        <div className={`${styles.wrap} ${styles.navInner}`}>
          <a
            className={styles.brand}
            href="/"
            aria-label={`${BRAND.name} home`}
          >
            <span className={styles.brandMark} />
            <span>{BRAND.name}</span>
          </a>
          <nav className={styles.navLinks} aria-label="Help and legal">
            {NAV.map((l) => (
              <a
                key={l.href}
                href={l.href}
                {...(current === l.href
                  ? { "aria-current": "page" as const }
                  : {})}
              >
                {l.label}
              </a>
            ))}
          </nav>
          <a className={styles.home} href="/">
            ← Home
          </a>
        </div>
      </header>

      {children}

      <footer className={styles.footer}>
        <div className={`${styles.wrap} ${styles.footerGrid}`}>
          <a className={styles.brand} href="/">
            <span className={styles.brandMark} />
            <span>{BRAND.name}</span>
          </a>
          <nav className={styles.footerLinks} aria-label="Footer">
            <a href={PAGES.privacy}>Privacy</a>
            <a href={PAGES.terms}>Terms</a>
            <a href={PAGES.support}>Support</a>
            <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>
          </nav>
        </div>
        <div className={styles.wrap}>
          <p className={styles.small}>
            © {year} {BRAND.name}
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * A long-form document (privacy policy, terms, support): title block, a
 * contents list on wide screens, then numbered sections with anchor ids.
 */
export function LegalLayout({
  path,
  kicker,
  title,
  lede,
  updated,
  summary,
  sections,
  contents = true,
}: {
  path: string;
  kicker: string;
  title: ReactNode;
  lede: ReactNode;
  updated?: string;
  /** Short plain-language summary shown above the sections. */
  summary?: ReactNode;
  sections: LegalSection[];
  contents?: boolean;
}) {
  return (
    <SiteShell current={path}>
      <main id="content">
        <div className={styles.wrap}>
          <div className={styles.head}>
            <span className={styles.kicker}>{kicker}</span>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.lede}>{lede}</p>
            {updated && (
              <p className={styles.updated}>Last updated {updated}</p>
            )}
          </div>
          <div
            className={`${styles.body} ${contents ? "" : styles.bodySingle}`}
          >
            {contents && (
              <nav className={styles.toc} aria-label="On this page">
                <p>On this page</p>
                <ol>
                  {sections.map((s) => (
                    <li key={s.id}>
                      <a href={`#${s.id}`}>{s.title}</a>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <div className={styles.prose}>
              {summary}
              {sections.map((s) => (
                <section className={styles.section} id={s.id} key={s.id}>
                  <h2>{s.title}</h2>
                  {s.body}
                </section>
              ))}
            </div>
          </div>
        </div>
      </main>
    </SiteShell>
  );
}

/** The support address as a mailto link, optionally with a subject line. */
export function SupportEmail({ subject }: { subject?: string }) {
  const query = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  return (
    <a href={`mailto:${BRAND.supportEmail}${query}`}>{BRAND.supportEmail}</a>
  );
}

/** Class names for content that pages put inside sections (tables, callouts, FAQ). */
export const legalStyles = styles;
