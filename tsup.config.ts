import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: { entry: "src/index.ts" },
  // Needed by the CLI; Node ignores a hashbang line in the library entry.
  banner: { js: "#!/usr/bin/env node" },
});
