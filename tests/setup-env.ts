// Test defaults point at docker-compose.dev.yml services, in a separate
// Postgres schema and Redis DB so tests never touch dev data.
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://vio:vio@localhost:55432/vio?schema=vitest",
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:56379/15",
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "vio-test",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
  S3_FORCE_PATH_STYLE: "true",
  S3_CREATE_BUCKET: "true",
  // Empty = use S3_ENDPOINT. Set explicitly because Prisma loads the dev .env,
  // which points these at docker-compose hostnames.
  S3_GPU_ENDPOINT: "",
  S3_BROWSER_ENDPOINT: "",
  S3_BROWSER_PROXY: "false",
  GPU_SERVICE_URL: process.env.TEST_GPU_SERVICE_URL ?? "http://127.0.0.1:58123",
  GPU_SERVICE_SECRET: "test-gpu-secret",
  SHOPIFY_API_KEY: "test-api-key",
  SHOPIFY_API_SECRET: "test-api-secret",
  SHOPIFY_APP_URL: "https://vio.example.com",
  SCOPES: "read_products,write_products,read_files,write_files",
  SHOP_CONCURRENCY: "3",
  FREE_CREDITS: "25",
};
for (const [k, v] of Object.entries(defaults)) {
  // Tests own these; don't inherit a developer's .env.
  process.env[k] = v;
}
