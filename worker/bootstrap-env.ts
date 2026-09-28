// Imported first by worker/index.ts. The worker never runs OAuth, so the app
// URL is irrelevant to it, but the Shopify library refuses to start without
// one. In development `shopify app dev` only hands the (tunnel) URL to the
// web process, so default it here.
process.env.SHOPIFY_APP_URL ||= "http://localhost";
