#!/usr/bin/env bun
/**
 * The `gossamer` bin. Deliberately trivial, and deliberately Effect-free.
 *
 * Effect and `@effect/platform-bun` are *optional* peer dependencies of
 * `gossamer`: the library entries (`.`, `./react`, `./vite`, `./config`) never
 * touch them, so a consumer who only declares SEO on routes and renders heads
 * does not install them. Only this CLI does.
 *
 * Which means the CLI must survive their absence with a sentence rather than a
 * module-resolution stack trace. A static import of `./main` would be hoisted and
 * fail before any of our code runs, so the real program is loaded dynamically —
 * that import is the package boundary where Effect first appears, and this is the
 * only place that can catch it failing to resolve.
 */

const MODULE_NOT_FOUND = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * The resolution failure's message, or undefined if this was not one.
 *
 * Keyed on `code` alone, never `instanceof Error`: Bun rejects an unresolvable
 * import with a `ResolveMessage`, which carries `code: "ERR_MODULE_NOT_FOUND"`
 * but is *not* an Error instance — an `instanceof` gate here would rethrow the
 * raw stack in exactly the case this exists to catch.
 */
const missingModuleMessage = (cause: unknown): string | undefined => {
  // NOTE: this zero-dependency bootstrap cannot import Effect before it diagnoses a missing optional Effect peer.
  if (typeof cause !== "object" || cause === null) return undefined;
  const { code, message } = cause as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || !MODULE_NOT_FOUND.has(code)) return undefined;
  return typeof message === "string" ? message : String(cause);
};

// NOTE: pre-Effect boundary: this catch exists precisely because Effect may not be installed yet, so it cannot be an Effect
const main = await import("./main").catch((cause: unknown) => {
  const message = missingModuleMessage(cause);
  if (message === undefined) {
    // NOTE: anything that is not a missing optional peer is a real crash; let it surface unchanged
    throw cause;
  }
  process.stderr.write(
    `✗ The \`gossamer\` CLI could not load its runtime dependencies.\n\n` +
      `  Effect is an optional peer dependency of gossamer — only the CLI needs it.\n` +
      `  Install it where the CLI runs:\n\n` +
      `      bun add -D effect @effect/platform-bun\n\n` +
      `  ${message}\n`,
  );
  return process.exit(1);
});

main.run();

export {};
