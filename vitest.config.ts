import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.jsonc", "**/*.md", "**/*.txt"],
  test: {
    environment: "node",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
