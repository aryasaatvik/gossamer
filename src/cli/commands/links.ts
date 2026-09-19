import * as Effect from "effect/Effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { crawlRenderedPages } from "../../audit/crawl";
import { buildRenderedGraph, diffLinkGraph, type SimpleEdge } from "../../core/links";
import { acquireGraph, loadSeoConfigOptional } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";
import { renderLinksReport, type LinksVerifyReport } from "../render";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const positive = (name: string, value: number): Effect.Effect<number, SeoCliError> =>
  Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(new SeoCliError({ message: `--${name} must be a positive integer` }));

const urlArg = Argument.String("url").pipe(
  Argument.withDescription("Absolute http(s) URL of the site homepage to crawl"),
);
const limitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Maximum pages to fetch, including the homepage"),
  Flag.withDefault(100),
);
const allowPrivate = Flag.Boolean("allow-private").pipe(
  Flag.withDescription("Allow localhost and private addresses (local development only)"),
  Flag.withDefault(false),
);
const requestTimeoutMs = Flag.Int("request-timeout-ms").pipe(
  Flag.withDescription("HTTP request timeout in milliseconds"),
  Flag.withDefault(15_000),
);
const maxBodyBytes = Flag.Int("max-body-bytes").pipe(
  Flag.withDescription("Maximum captured response bytes per page"),
  Flag.withDefault(2_000_000),
);

/**
 * The declared graph is optional input. A missing `seo.config.ts` means the
 * rendered-only report; a config that exists but fails to load is a warning, not
 * a failure, because verifying served HTML works on any deployed site.
 */
const loadDeclaredEdges: Effect.Effect<ReadonlyArray<SimpleEdge> | undefined> = Effect.gen(
  function* () {
    const config = yield* loadSeoConfigOptional;
    if (config === undefined) return undefined;
    const graph = yield* Effect.scoped(acquireGraph(config));
    // Only `related` edges are deliberate in-copy cross-links. Breadcrumbs are
    // nav-region anchors, redirects render no anchor, and collection membership
    // is not a rendered link — diffing them against body anchors would be noise.
    return graph.edges
      .filter((edge) => edge.type === "related")
      .map((edge): SimpleEdge => ({ from: edge.from, to: edge.to }));
  },
).pipe(
  Effect.catchTag("SeoCliError", (error) =>
    Effect.logWarning(`Ignoring declared graph: ${error.message}`).pipe(Effect.as(undefined)),
  ),
);

const linksVerifyCommand = Command.make("verify", {
  url: urlArg,
  json: jsonFlag,
  limit: limitFlag,
  allowPrivate,
  requestTimeoutMs,
  maxBodyBytes,
}).pipe(
  Command.withDescription(
    "Crawl served HTML and report homepage depth, rendered orphans, and the declared-vs-rendered gap",
  ),
  Command.withExamples([
    {
      command: "pagegraph links verify https://example.com",
      description: "Crawl the homepage and report the rendered link graph",
    },
    {
      command: "pagegraph links verify https://example.com --limit 25",
      description: "Bound the crawl to 25 pages",
    },
    {
      command: "pagegraph links verify https://example.com --json | jq",
      description: "One versioned JSON report on stdout",
    },
    {
      command: "pagegraph links verify http://localhost:3000 --allow-private",
      description: "Verify a local app",
    },
  ]),
  Command.withHandler(
    Effect.fn("SeoCli.linksVerify")(function* (options) {
      const checkedLimit = yield* positive("limit", options.limit);
      const checkedTimeout = yield* positive("request-timeout-ms", options.requestTimeoutMs);
      const checkedMaxBody = yield* positive("max-body-bytes", options.maxBodyBytes);

      const crawl = yield* Effect.tryPromise({
        try: () =>
          crawlRenderedPages(options.url, {
            limit: checkedLimit,
            timeoutMs: checkedTimeout,
            maxBodyBytes: checkedMaxBody,
            allowPrivate: options.allowPrivate,
          }),
        catch: (cause) =>
          new SeoCliError({ message: `Could not crawl ${options.url}: ${messageOf(cause)}` }),
      });

      if (crawl.pages.length === 0) {
        const reason = crawl.failures[0]?.error ?? "no pages fetched";
        return yield* new SeoCliError({
          message: `No page could be crawled at ${options.url}: ${reason}`,
        });
      }

      const graph = buildRenderedGraph(crawl.origin, crawl.pages);
      const declaredEdges = yield* loadDeclaredEdges;
      const diff =
        declaredEdges === undefined ? undefined : diffLinkGraph(declaredEdges, graph);

      const report: LinksVerifyReport = {
        kind: "links-verify",
        schemaVersion: 1,
        origin: crawl.origin,
        seed: crawl.seed,
        crawl: {
          pages: crawl.pages.length,
          limit: crawl.limit,
          truncated: crawl.truncated,
          failures: crawl.failures,
        },
        rendered: {
          pages: crawl.pages.length,
          internalEdges: graph.internalEdges.length,
          contextualEdges: graph.contextualEdges.length,
          maxDepth: graph.maxDepth,
          orphans: graph.orphans,
        },
        declared:
          diff === undefined
            ? null
            : {
                edges: diff.declaredCount,
                contextualEdges: diff.renderedContextualCount,
                declaredNotRendered: diff.declaredNotRendered,
                renderedNotDeclared: diff.renderedNotDeclared,
              },
      };

      if (options.json) yield* printJson(report);
      else yield* printText(renderLinksReport(report));
    }),
  ),
);

/**
 * `pagegraph links` groups rendered link-graph capabilities. `verify` is the
 * first: crawl served HTML and report what a crawler actually receives.
 */
export const linksCommand = Command.make("links").pipe(
  Command.withDescription("Rendered link-graph verification and planning"),
  Command.withSubcommands([linksVerifyCommand]),
);
