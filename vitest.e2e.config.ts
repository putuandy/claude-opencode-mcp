import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 300_000,
    pool: "forks",
    fileParallelism: false,
  },
});
