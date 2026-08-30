import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ailyn/business-rules": new URL("../../packages/business-rules/src/index.ts", import.meta.url).pathname,
      "@ailyn/config": new URL("../../packages/config/src/index.ts", import.meta.url).pathname,
      "@ailyn/schemas": new URL("../../packages/schemas/src/index.ts", import.meta.url).pathname,
      "@ailyn/shared": new URL("../../packages/shared/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    globals: true,
    include: ["**/*.scenario.spec.ts"],
    environment: "node"
  }
});
