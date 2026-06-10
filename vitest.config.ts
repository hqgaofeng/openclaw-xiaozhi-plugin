import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // v0.4.0-rc3 (batch 3): onnxruntime-node is a native binding
    // that some vitest versions try to transform. Forcing
    // server.deps.inline=[] and external=onnxruntime-node keeps
    // it as a runtime require, which matches the dynamic-import
    // pattern in src/vad-silero.ts. If we ever see
    // "Cannot find module 'onnxruntime-node'" in CI, that's
    // the fix.
    server: {
      deps: {
        inline: [],
        external: ["onnxruntime-node", "sherpa-onnx"],
      },
    },
    timeout: 30000, // silero init + first inference can be slow on cold CI
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**", "src/**/*.test.ts", "src/index.ts"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
