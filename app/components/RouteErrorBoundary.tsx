import type { ErrorResponse } from "react-router";
import { isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { HelpFooter, SupportLink } from "./HelpFooter";

export interface NotFoundCopy {
  heading: string;
  message: string;
  backHref: string;
  backLabel: string;
}

const NOT_FOUND: NotFoundCopy = {
  heading: "We couldn't find that page",
  message: "The link may be out of date.",
  backHref: "/app",
  backLabel: "Back to Home",
};

/**
 * Render a thrown Response the way Shopify's boundary does: its auth responses (bounce page,
 * exit-iframe) are HTML that must reach the document as is. boundary.error recognises the
 * response by its class name, which the minified client bundle renames, so on hydration it
 * rethrows. Render the same markup the server did instead of crashing the page.
 */
export function shopifyResponse(error: ErrorResponse) {
  try {
    return boundary.error(error);
  } catch {
    const html = typeof error.data === "string" && error.data ? error.data : "Handling response";
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  }
}

/**
 * ErrorBoundary for the /app/* child routes. It renders inside app.tsx's AppProvider, so the
 * nav and App Bridge keep working: a friendly page for 404s and unexpected errors, and
 * Shopify's handling for any other thrown response.
 */
export function RouteErrorBoundary({ notFound }: { notFound?: Partial<NotFoundCopy> }) {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) return <NotFoundPage copy={{ ...NOT_FOUND, ...notFound }} />;
    return shopifyResponse(error);
  }
  return <UnexpectedErrorPage />;
}

function NotFoundPage({ copy }: { copy: NotFoundCopy }) {
  return (
    <s-page heading={copy.heading}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>{copy.message}</s-paragraph>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button variant="primary" href={copy.backHref}>
              {copy.backLabel}
            </s-button>
            <SupportLink />
          </s-stack>
        </s-stack>
      </s-section>
      <HelpFooter />
    </s-page>
  );
}

/**
 * Also used by app.tsx when its own loader fails, wrapped in an AppProvider there. Without App
 * Bridge a plain link to /app would drop the embedded query (shop, host, id_token), so that
 * fallback passes its own homeHref.
 */
export function UnexpectedErrorPage({ homeHref = "/app" }: { homeHref?: string }) {
  const location = useLocation();
  return (
    <s-page heading="Something went wrong">
      <s-banner tone="critical" heading="This page couldn't load">
        Please try again in a moment. If it keeps happening, <SupportLink>contact support</SupportLink> and tell us
        what you were doing.
        <s-button slot="secondary-actions" href={`${location.pathname}${location.search}`}>
          Try again
        </s-button>
        <s-button slot="secondary-actions" href={homeHref}>
          Go to Home
        </s-button>
      </s-banner>
      <HelpFooter />
    </s-page>
  );
}
