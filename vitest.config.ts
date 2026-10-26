import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    fileParallelism: false,
    // Live tests call real (test-mode) APIs; they only run through `npm run test:live`.
    exclude: process.env.FORGET_USER_LIVE
      ? configDefaults.exclude
      : [...configDefaults.exclude, "test/live/**"],
  },
});
