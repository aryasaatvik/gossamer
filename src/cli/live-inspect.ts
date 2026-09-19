/**
 * `gossamer inspect <url> --live`: fetch a URL and hand its body to the pure head
 * validator in `../inspect-html`. The fetch is all that lives here — the
 * validation is a library capability, not a CLI one, so it stays out of the
 * Effect-bearing half of the package.
 */

import * as Effect from "effect/Effect";

import { inspectHtml, type LiveHeadReport } from "../core/inspect-html";
import { SeoCliError } from "./output";

/** Fetch a URL and inspect its `<head>`. Network failures surface as SeoCliError. */
export const fetchAndInspect = (url: string): Effect.Effect<LiveHeadReport, SeoCliError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { headers: { "user-agent": "gossamer-cli" } });
      const html = await response.text();
      return inspectHtml(url, response.status, html);
    },
    catch: (cause) =>
      new SeoCliError({
        message: `Could not fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
