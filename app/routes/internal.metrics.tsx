import type { LoaderFunctionArgs } from "react-router";
import { env } from "../lib/env.server";
import { log } from "../lib/log.server";
import { METRICS_MAX_DAYS, processingMetrics, tokenMatches } from "../lib/metrics.server";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });

export const action = () => json({ error: "Method not allowed. Use GET." }, 405, { Allow: "GET" });

/**
 * GET /internal/metrics?days=7: the processing cost dashboard as JSON (the same summary as
 * `npm run report:processing -- --json`, overall and per UTC day), for a future dashboard.
 * Authorization: Bearer METRICS_TOKEN. 404 while METRICS_TOKEN is unset (the endpoint doesn't
 * exist), 401 for a missing or wrong token, 400 for days outside 1–90. Not for merchants: no
 * shop is named in the answer.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const expected = env().METRICS_TOKEN;
  if (!expected) return json({ error: "Not found" }, 404);
  const presented = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!presented || !tokenMatches(presented, expected)) {
    return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="metrics"' });
  }
  const raw = new URL(request.url).searchParams.get("days") ?? "7";
  const days = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > METRICS_MAX_DAYS) {
    return json({ error: `days must be a whole number from 1 to ${METRICS_MAX_DAYS}.` }, 400);
  }
  try {
    return json(await processingMetrics(days));
  } catch (error) {
    log.error("metrics failed", { error: error instanceof Error ? error.message : String(error) });
    return json({ error: "Something went wrong." }, 500);
  }
};
