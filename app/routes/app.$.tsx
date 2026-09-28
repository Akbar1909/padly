import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

// Unknown /app/* URLs. Without this route they fall through to the site's root 404, which has no
// AppProvider, App Bridge or nav inside the admin. The layout loader (app.tsx) authenticates.
export const loader = () => {
  throw new Response("Not found", { status: 404 });
};

export default function NotFound() {
  return null;
}

export function ErrorBoundary() {
  return <RouteErrorBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
