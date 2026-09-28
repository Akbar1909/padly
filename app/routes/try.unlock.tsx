import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { isOwnerToken, ownerCookie } from "../lib/try.server";

/**
 * Owner unlock: a password form that marks this browser for unlimited free
 * tries. The token is only ever POSTed in the body, never put in a URL, so it
 * can't end up in access logs or browser history. ?token= is ignored.
 */

const MAX_BODY_BYTES = 4 * 1024;
/** Same wait for every wrong answer, so timing says nothing about the token. */
const FAILURE_DELAY_MS = 750;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Owner unlock</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  form { width: 100%; max-width: 320px; display: grid; gap: 12px; }
  h1 { font-size: 20px; margin: 0; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid GrayText; }
  button { cursor: pointer; background: CanvasText; color: Canvas; border-color: CanvasText; }
</style>
</head>
<body>
<form method="post" action="/try/unlock">
  <h1>Owner unlock</h1>
  <label for="token">Owner token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required minlength="16" autofocus>
  <button type="submit">Unlock this browser</button>
</form>
</body>
</html>`;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const notFound = () => new Response("Not found", { status: 404, headers: HEADERS });

export const loader = () =>
  new Response(PAGE, {
    headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });

export const action = async ({ request }: ActionFunctionArgs) => {
  const length = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413, headers: HEADERS });
  }
  let token: string | null = null;
  try {
    const value = (await request.formData()).get("token");
    token = typeof value === "string" ? value : null;
  } catch {
    // Not a form body: treated like a wrong token.
  }
  if (!isOwnerToken(token)) {
    await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
    return notFound();
  }
  return redirect("/#try", {
    headers: { "Set-Cookie": ownerCookie(), "Cache-Control": "no-store" },
  });
};
