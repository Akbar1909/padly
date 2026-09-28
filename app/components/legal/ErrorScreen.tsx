import type { CSSProperties } from "react";

import { BRAND, PAGES } from "../../lib/brand";

/*
 * Last-resort error page, rendered by the root ErrorBoundary for errors no route handled.
 * Inline styles only: root.tsx is part of every page, including the embedded app, so it
 * must not pull the public site's stylesheet or fonts into them.
 */

const INK = "#16130f";
const PAPER = "#f3efe6";

const css: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    margin: 0,
    display: "grid",
    placeItems: "center",
    padding: "48px 16px",
    boxSizing: "border-box",
    background: PAPER,
    color: INK,
    fontFamily: '"Helvetica Neue", Arial, sans-serif',
    fontSize: 17,
    lineHeight: 1.55,
  },
  card: { maxWidth: 560, width: "100%" },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    fontWeight: 600,
    color: INK,
    textDecoration: "none",
  },
  mark: {
    width: 26,
    height: 26,
    borderRadius: 7,
    background: INK,
    boxShadow: "inset 0 0 0 6px #16130f, inset 0 0 0 7.5px #ff5a1f",
    flex: "none",
  },
  code: {
    display: "block",
    marginTop: 40,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#b8360a",
  },
  title: {
    fontFamily: '"Iowan Old Style", Georgia, serif',
    fontWeight: 400,
    fontSize: "clamp(38px, 8vw, 60px)",
    lineHeight: 1,
    letterSpacing: "-0.02em",
    margin: "14px 0 16px",
  },
  text: { margin: "0 0 12px", color: "#3b352d" },
  link: { color: "#b8360a" },
  actions: { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 },
  button: {
    display: "inline-flex",
    alignItems: "center",
    height: 46,
    padding: "0 20px",
    borderRadius: 999,
    border: `1.5px solid ${INK}`,
    background: INK,
    color: PAPER,
    fontWeight: 600,
    fontSize: 15,
    textDecoration: "none",
  },
  ghost: { background: "transparent", color: INK },
  details: {
    marginTop: 24,
    padding: 12,
    borderRadius: 8,
    background: "#ebe5d8",
    fontSize: 13,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
};

export function ErrorScreen({
  status,
  embedded,
  details,
}: {
  /** HTTP status for thrown responses; undefined for crashes. */
  status?: number;
  /** Inside the Shopify admin: send people back through the admin, not to our homepage. */
  embedded: boolean;
  /** Development only: the error message. */
  details?: string;
}) {
  const notFound = status === 404;
  const mail = `mailto:${BRAND.supportEmail}?subject=${encodeURIComponent(`${BRAND.name} error`)}`;
  return (
    <main style={css.page}>
      {/* Drop the browser's default body margin; only rendered on error pages. */}
      <style>{`html,body{margin:0;background:${PAPER}}`}</style>
      <div style={css.card}>
        {embedded ? (
          <span style={css.brand}>
            <span style={css.mark} />
            <span>{BRAND.name}</span>
          </span>
        ) : (
          <a style={css.brand} href="/" aria-label={`${BRAND.name} home`}>
            <span style={css.mark} />
            <span>{BRAND.name}</span>
          </a>
        )}
        <span style={css.code}>
          {notFound
            ? "404 · Not found"
            : `${status ?? "Error"} · Something went wrong`}
        </span>
        <h1 style={css.title}>
          {notFound ? "This page isn't here." : "Sorry, that didn't work."}
        </h1>
        {embedded ? (
          <p style={css.text}>
            {notFound
              ? "The page you opened doesn't exist in the app."
              : "Something went wrong on our side."}{" "}
            Reopen {BRAND.name} from Apps in your Shopify admin to continue.
          </p>
        ) : (
          <p style={css.text}>
            {notFound
              ? "The link may be old or mistyped."
              : "Something went wrong on our side. Please try again in a moment."}
          </p>
        )}
        <p style={css.text}>
          If it keeps happening, email{" "}
          <a style={css.link} href={mail} target="_blank" rel="noreferrer">
            {BRAND.supportEmail}
          </a>
          .
        </p>
        {!embedded && (
          <div style={css.actions}>
            <a style={css.button} href="/">
              Go to the home page
            </a>
            <a style={{ ...css.button, ...css.ghost }} href={PAGES.support}>
              Support
            </a>
          </div>
        )}
        {details && <pre style={css.details}>{details}</pre>}
      </div>
    </main>
  );
}
