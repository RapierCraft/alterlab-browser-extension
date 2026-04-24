/**
 * AlterLab Connect — Vitest Configuration
 *
 * Unit tests for pure utility functions in shared.js.
 * Uses the 'node' environment since extension APIs (browser.storage, DOM) are
 * mocked in tests rather than requiring a real browser context.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.mjs", "tests/unit/**/*.test.js"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["shared.js"],
    },
  },
});
