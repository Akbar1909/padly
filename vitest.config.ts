import { defineConfig } from "vitest/config";

// Unit tests: no services needed. Integration tests: see vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
  },
});
