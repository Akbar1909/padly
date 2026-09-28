import { defineConfig } from "vitest/config";

// Needs Postgres, Redis and MinIO: docker compose -p vio-dev -f docker-compose.dev.yml up -d
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
