import type { ReactNode } from "react";
import type { MetaFunction } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from "react-router";

import { ErrorScreen } from "./components/legal/ErrorScreen";
import { BRAND } from "./lib/brand";

/** The embedded app and its auth pages use Polaris (Inter from Shopify's CDN); the public site doesn't. */
const isShopifyPath = (pathname: string) =>
  /^\/(app|auth)(\/|$)/.test(pathname);

// A title for the root ErrorBoundary on public pages (they have no boundaries of their
// own). Embedded paths are skipped: there app.tsx's boundary also renders Shopify's auth
// responses, which aren't failures, and the admin shows its own title anyway.
export const meta: MetaFunction = ({ error, location }) =>
  error && !isShopifyPath(location.pathname)
    ? [
        {
          title:
            isRouteErrorResponse(error) && error.status === 404
              ? `Page not found · ${BRAND.name}`
              : `Something went wrong · ${BRAND.name}`,
        },
        { name: "robots", content: "noindex" },
      ]
    : [];

/** Document shell, shared by every route and by the error boundary below. */
export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/svg+xml" href="/brand/icon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {isShopifyPath(pathname) && (
          <>
            <link rel="preconnect" href="https://cdn.shopify.com/" />
            <link
              rel="stylesheet"
              href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
            />
          </>
        )}
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Backstop for errors no route boundary handled: the public pages (which have no boundaries
 * of their own), 405s for POSTs to pages without an action, and anything thrown while
 * rendering app.tsx's own boundary (unknown /app paths get app.$.tsx's 404 inside the
 * admin, with the nav). Shows a branded page instead of React Router's default, with no
 * stack trace outside development.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const { pathname } = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : undefined;
  const details =
    import.meta.env.DEV && error instanceof Error
      ? `${error.message}\n\n${error.stack ?? ""}`
      : undefined;
  return (
    <ErrorScreen
      status={status}
      embedded={/^\/app(\/|$)/.test(pathname)}
      details={details}
    />
  );
}
