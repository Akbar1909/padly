import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { login } from "../../shopify.server";

/**
 * No login form: merchants install and open the app from Shopify (the App Store listing or the
 * admin), never by typing a .myshopify.com domain (App Store requirement 2.3.1). A request that
 * already carries ?shop= (from Shopify or the library's own redirects) still goes through
 * login(), which throws the redirect into Shopify's install/OAuth flow. Anything else, including
 * an invalid shop, goes to the website.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (new URL(request.url).searchParams.get("shop")) {
    await login(request);
  }
  throw redirect("/");
};

export const action = async () => redirect("/");
