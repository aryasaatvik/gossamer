import { defineConfig } from "tsdown";

// One entry per public `exports` subpath, plus `cli` for the `bin`. Two passes so
// the CLI can bundle Effect while the library entries stay dependency-free.
//
// The library entries are pure data + string rendering (the core) or adapters to
// Vite/React. Their `node:` imports stay external and they never reach Effect, so a
// consumer that only declares SEO on routes installs no runtime dependency.
//
// `cli` is the one entry that reaches Effect and the Bun platform adapter. It is
// built as a separate pass that **bundles** `effect` and `@effect/*`: a published
// binary that resolved Effect from the consumer's tree would couple to the
// consumer's RC, and the `effect/unstable/cli` constructors rename between RCs
// (`Flag.boolean` → `Flag.Boolean` at rc.113). Bundling makes the binary
// self-contained. `vite` and `lighthouse` stay external — the CLI loads the app
// graph through Vite and spawns Lighthouse, both optional peers.
const base = {
  format: ["esm"],
  outDir: "dist",
  dts: true,
  sourcemap: true,
  platform: "neutral",
  // Neutral resolves no Node builtins, so `node:*` imports are declared external
  // here rather than left to be inferred with a warning.
  deps: { neverBundle: [/^node:/] },
  // Emit `.js` (not `.mjs`) so the `exports` map points at plain `.js`; the
  // package is `type: module`, so `.js` is ESM.
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...base,
    entry: {
      index: "src/core/index.ts",
      react: "src/react/index.ts",
      vite: "src/vite/index.ts",
      config: "src/config/index.ts",
      audit: "src/audit/index.ts",
    },
    // `schema-dts` is types-only: it is bundled into the `.d.ts` and erases from
    // the JS, which is what keeps `.`/`./react` free of runtime dependencies.
    clean: true,
  },
  {
    ...base,
    entry: { cli: "src/cli/bin.ts" },
    // The library pass owns the clean; this pass appends the CLI artifacts.
    clean: false,
    deps: {
      neverBundle: [/^node:/],
      alwaysBundle: [/^effect(\/|$)/, /^@effect\//],
    },
  },
]);
