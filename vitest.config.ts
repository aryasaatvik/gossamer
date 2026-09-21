import { defineConfig } from "vitest/config";

import { textImports } from "./scripts/text-imports.ts";

export default defineConfig({
  plugins: [textImports()],
  test: {
    environment: "node",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
