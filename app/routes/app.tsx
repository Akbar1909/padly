import type { HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { isRouteErrorResponse, Outlet, useLoaderData, useLocation, useRouteError, useRouteLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { requireShop } from "../lib/app-context.server";
import { shopifyResponse, UnexpectedErrorPage } from "../components/RouteErrorBoundary";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireShop(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

/**
 * The layout's only data is the API key, which never changes, and every child loader
 * authenticates its own request (requireShop). So revalidations (after an action, the job
 * page's refresh, a ?tab= change) don't re-run it: one authentication per refresh, not two.
 * A navigation into the app from outside still runs it (it has no data yet then).
 */
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {/* rel="home" hides this item and makes the app name the Home link. Polaris' s-link types
            don't list `rel` (App Bridge reads it), hence the spread. */}
        <s-link href="/app" {...{ rel: "home" }}>
          Home
        </s-link>
        <s-link href="/app/jobs">Jobs</s-link>
        <s-link href="/app/jobs/new">New job</s-link>
        <s-link href="/app/billing">Credits</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
// Child routes have their own boundary (RouteErrorBoundary), so this one only sees errors from this
// layout itself, usually from authentication in the loader.
export function ErrorBoundary() {
  const error = useRouteError();
  // Present when the loader succeeded and only rendering failed.
  const data = useRouteLoaderData<typeof loader>("routes/app");
  const location = useLocation();
  if (isRouteErrorResponse(error)) return shopifyResponse(error);

  // The App component (and its AppProvider) is replaced by this boundary, so load Polaris here.
  return data?.apiKey ? (
    <AppProvider embedded apiKey={data.apiKey}>
      <UnexpectedErrorPage />
    </AppProvider>
  ) : (
    // No App Bridge here, so links are plain navigations: keep the query the admin opened us with.
    <AppProvider embedded={false}>
      <UnexpectedErrorPage homeHref={`/app${location.search}`} />
    </AppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
