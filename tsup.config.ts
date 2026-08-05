import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node20",
    external: ["sharp"],
  },
  {
    entry: { cli: "src/cli/bin.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node20",
    external: ["sharp"],
    banner: { js: "#!/usr/bin/env node" },
  },
]);
