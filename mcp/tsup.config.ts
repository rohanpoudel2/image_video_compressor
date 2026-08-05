import { defineConfig } from "tsup";

export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node20.11",
  platform: "node",
  clean: true,
  sourcemap: true,
  // The SDK and the compressor stay external: bundling either would duplicate
  // code the consumer already installs, and sharp carries native binaries that
  // cannot be bundled at all.
  external: ["@modelcontextprotocol/sdk", "image-and-video-compressor", "zod", "sharp"],
  banner: { js: "#!/usr/bin/env node" },
});
