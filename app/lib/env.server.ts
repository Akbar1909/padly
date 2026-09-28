import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  SHOPIFY_API_KEY: z.string().default(""),
  // Read by the Shopify library directly; validated here so /healthz fails when it's missing
  // in production (webhook HMACs and token exchange silently fail without it).
  SHOPIFY_API_SECRET: z.string().default(""),
  SHOPIFY_APP_URL: z.string().default(""),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  // Cloudflare R2 (or any S3-compatible store).
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool(false),
  S3_CREATE_BUCKET: bool(false),
  // Hosts used when presigning URLs for other parties. In production with R2
  // these are all unset and S3_ENDPOINT is used. In docker-compose dev the
  // browser and the GPU container reach MinIO under different hostnames.
  S3_BROWSER_ENDPOINT: z.string().optional(),
  S3_GPU_ENDPOINT: z.string().optional(),
  // Serve browser image URLs through the app (/s3-proxy/...) when the object
  // store isn't publicly reachable: local MinIO in dev (browsers block
  // http://localhost images inside the admin) or MinIO on a private network
  // (docker-compose.vps.yml). Leave off with R2.
  S3_BROWSER_PROXY: bool(false),

  GPU_SERVICE_URL: z.string().url(),
  GPU_SERVICE_SECRET: z.string().min(8),
  GPU_TIMEOUT_MS: int(180_000),

  // Item tasks one worker process runs at once. IMAGE_WORKER_CONCURRENCY is an alias that
  // wins when set. Real image throughput is set by the image service (gpu-service
  // MAX_CONCURRENCY) and SHOP_CONCURRENCY, not by this: extra slots just wait on the service.
  WORKER_CONCURRENCY: int(8),
  IMAGE_WORKER_CONCURRENCY: z.coerce.number().int().positive().optional(),
  // Max items one shop can have in flight at once, so a big catalog can't starve other shops.
  SHOP_CONCURRENCY: int(3),
  // BullMQ attempts per claimed image task, with exponential backoff from ITEM_RETRY_BASE_MS
  // (30 s, 1 min, 2 min, 4 min by default), so a short image-service outage doesn't fail the
  // backlog. Permanent errors are never retried.
  ITEM_TASK_ATTEMPTS: int(5),
  ITEM_RETRY_BASE_MS: int(30_000),
  // Above this many matching products, read media with a bulk operation.
  BULK_READ_THRESHOLD: int(250),
  MAX_ITEMS_PER_JOB: int(5000),
  REVIEW_EXPIRY_DAYS: int(14),

  FREE_CREDITS: int(25),
  // Landing page "try it with your own photo": free previews per visitor per day.
  TRY_DAILY_LIMIT: int(3),
  // Cap on anonymous tries per day across all visitors, so the public demo can't crowd out
  // merchants' jobs on the shared image service (or run up the Replicate bill).
  TRY_GLOBAL_DAILY_LIMIT: int(300),
  // Secret typed into the owner unlock form (/try/unlock, POST only) that lifts the
  // per-visitor daily limit in one browser.
  TRY_OWNER_TOKEN: z.string().min(16).optional(),
  // Optional donation link (Tirikchilik, Ko-fi, …). The donate button is hidden when unset.
  DONATE_URL: z.string().url().optional(),
  // The app's Shopify App Store listing, once approved. Install buttons on the website link
  // here; until it's set they say the app is coming to the App Store. Never ask visitors to
  // type a .myshopify.com domain (App Store requirement 2.3.1).
  APP_STORE_URL: z.string().url().optional(),
  // Test charges are never billed but still add credits, so this must be off in production.
  BILLING_TEST: bool(process.env.NODE_ENV !== "production"),
  // Completion emails. No provider is implemented yet, so nothing is sent whatever this is set
  // to (app/lib/notifications.server.ts emailSender). Update the privacy policy before adding one.
  EMAIL_PROVIDER: z.string().trim().min(1).optional(),

  // Bearer token for GET /internal/metrics (the processing cost dashboard as JSON). The route
  // answers 404 while unset. An empty value counts as unset.
  METRICS_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
  // Average paid (Replicate) cut-out cost in USD, used for "estimated spend avoided" when the
  // records summarised show no paid cut-out to average.
  REPLICATE_AVG_CUTOUT_USD: z.coerce.number().nonnegative().default(0.0009),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parsed and validated environment. Parsed lazily so `react-router build` works without secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment:\n${issues}`);
    }
    cached = {
      ...parsed.data,
      WORKER_CONCURRENCY: parsed.data.IMAGE_WORKER_CONCURRENCY ?? parsed.data.WORKER_CONCURRENCY,
    };
    if (cached.NODE_ENV === "production" && !cached.SHOPIFY_API_SECRET) {
      throw new Error("Invalid environment:\n  SHOPIFY_API_SECRET: required in production");
    }
    if (cached.NODE_ENV === "production" && cached.BILLING_TEST) {
      console.warn(
        "WARNING: BILLING_TEST=true in production. Credit packs are free test charges but still add credits.",
      );
    }
  }
  return cached;
}

/** Tests: read the environment again on the next env() call. */
export function resetEnvCache(): void {
  cached = undefined;
}
