/**
 * Shared surfaces for the `pagegraph` CLI. The three output planes:
 *  - **data** → stdout via {@link printJson} / {@link printText}. Under `--json`
 *    this is the *only* thing on stdout: no ANSI, no status, valid JSON.
 *  - **status** → stderr via Effect leveled logging (`Effect.logInfo` /
 *    `Effect.logDebug`), routed off stdout by `Logger.LogToStderr` in `main.ts`
 *    and gated by the built-in `--log-level` flag.
 *  - **diagnostics** → stderr; expected failures surface as {@link SeoCliError},
 *    printed by the entrypoint with a non-zero exit.
 */

import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Flag from "effect/unstable/cli/Flag";

/** Expected, user-facing CLI failure — message to stderr, process exits non-zero. */
export class SeoCliError extends Data.TaggedError("SeoCliError")<{
  readonly message: string;
}> {}

/** Machine-readable output. When set, stdout is exactly the JSON payload. */
export const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit the payload as JSON on stdout (no status, no color)"),
  Flag.withDefault(false),
);

/**
 * Absolute origin the sitemap/robots projection is rendered under. It carries no
 * static default: the fallback is the host's own `origin` from `seo.config.ts`,
 * which is not known until the config is loaded. Resolve it with {@link originOf}.
 */
export const originFlag = Flag.string("origin").pipe(
  Flag.withDescription("Absolute origin for URLs (default: `origin` from seo.config.ts)"),
  Flag.optional,
);

/** The `--origin` flag when given, else the origin the config declares. */
export const originOf = (flag: Option.Option<string>, configured: string): string =>
  Option.getOrElse(flag, () => configured);

/**
 * `--indexable` (default true) / `--no-indexable`. A non-indexable host yields a
 * disallow-all robots.txt with no Sitemap line — the preview posture.
 */
export const indexableFlag = Flag.boolean("indexable").pipe(
  Flag.withDescription("Render as an indexable host; --no-indexable = disallow-all robots.txt"),
  Flag.withDefault(true),
);

/** Data plane: pretty-printed JSON on stdout. */
export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

/** Data plane: a block of already-formatted text on stdout. */
export const printText = (text: string) => Console.log(text);
