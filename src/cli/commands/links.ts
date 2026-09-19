import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import type * as Config from "effect/Config";
import type * as AiError from "effect/unstable/ai/AiError";
import type * as DecisionModel from "effect/unstable/ai/DecisionModel";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { readFileSync } from "node:fs";

import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";

import { crawlRenderedPages } from "../../audit/crawl";
import {
  candidateSourceText,
  decodeRenderedEdges,
  generateLinkCandidates,
} from "../../core/link-candidates";
import { buildRenderedGraph, diffLinkGraph, type SimpleEdge } from "../../core/links";
import {
  decideLinks,
  decodeLinkCandidates,
  DEFAULT_LINK_THRESHOLD,
  type LinkCandidate,
  type LinksDecideReport,
} from "../../links/decide";
import { acquireGraph, loadSeoConfig, loadSeoConfigOptional } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";
import {
  renderLinksCandidatesReport,
  renderLinksDecideReport,
  renderLinksReport,
  type LinksCandidatesReport,
  type LinksVerifyReport,
} from "../render";

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

interface DeclaredGraph {
  readonly origin: string;
  readonly edges: ReadonlyArray<SimpleEdge>;
}

type DeclaredResult =
  | { readonly kind: "loaded"; readonly graph: DeclaredGraph }
  | { readonly kind: "absent" }
  | { readonly kind: "warning"; readonly message: string };

/**
 * The declared graph is optional input. A missing `seo.config.ts` means the
 * rendered-only report; a config that exists but fails to load is a warning, not
 * a failure, because verifying served HTML works on any deployed site. Origins
 * are compared before diffing, so a graph from another project is never silently
 * attributed to this crawl.
 */
const loadDeclaredGraph: Effect.Effect<DeclaredResult> = Effect.gen(function* () {
  const config = yield* loadSeoConfigOptional;
  if (config === undefined) return { kind: "absent" } as const;
  let configOrigin: string;
  try {
    configOrigin = new URL(config.origin).origin;
  } catch {
    return {
      kind: "warning",
      message: `Ignoring declared graph: seo.config.ts origin "${config.origin}" is not a valid URL.`,
    } as const;
  }
  const graph = yield* Effect.scoped(acquireGraph(config));
  // Only `related` edges are deliberate in-copy cross-links. Breadcrumbs are
  // nav-region anchors, redirects render no anchor, and collection membership
  // is not a rendered link — diffing them against body anchors would be noise.
  return {
    kind: "loaded",
    graph: {
      origin: configOrigin,
      edges: graph.edges
        .filter((edge) => edge.type === "related")
        .map((edge): SimpleEdge => ({ from: edge.from, to: edge.to })),
    },
  } as const;
}).pipe(
  Effect.catchTag("SeoCliError", (error) =>
    Effect.succeed({ kind: "warning", message: `Ignoring declared graph: ${error.message}` } as const),
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

      const graph = buildRenderedGraph(crawl.origin, crawl.pages, crawl.root);
      const warnings: Array<string> = [];
      if (crawl.truncatedBodies.length > 0) {
        warnings.push(
          `${crawl.truncatedBodies.length} page body/bodies exceeded --max-body-bytes; anchors past the cutoff are missing.`,
        );
      }

      const declared = yield* loadDeclaredGraph;
      let declaredEdges: ReadonlyArray<SimpleEdge> | undefined;
      if (declared.kind === "warning") warnings.push(declared.message);
      if (declared.kind === "loaded") {
        if (declared.graph.origin === crawl.origin) {
          declaredEdges = declared.graph.edges;
        } else {
          warnings.push(
            `Declared graph origin ${declared.graph.origin} differs from crawled origin ${crawl.origin}; skipping the declared-vs-rendered diff.`,
          );
        }
      }
      const diff = declaredEdges === undefined ? undefined : diffLinkGraph(declaredEdges, graph);

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
          bodyTruncated: crawl.truncatedBodies.length > 0,
          truncatedPages: crawl.truncatedBodies,
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
        warnings,
      };

      if (options.json) yield* printJson(report);
      else yield* printText(renderLinksReport(report));
    }),
  ),
);

const decideFile = Argument.String("file").pipe(
  Argument.withDescription("JSON file with an array of link candidates (default: stdin)"),
  Argument.optional,
);
const thresholdFlag = Flag.Finite("threshold").pipe(
  Flag.withDescription("Probability above which an answer is confident; below is review (0.5 < t < 1)"),
  Flag.withDefault(DEFAULT_LINK_THRESHOLD),
);
const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("TypeSafe System One model identifier"),
  Flag.withDefault("jev-latest"),
);
const concurrencyFlag = Flag.Int("concurrency").pipe(
  Flag.withDescription("Maximum concurrent decision calls"),
  Flag.withDefault(4),
);

const checkThreshold = (value: number): Effect.Effect<number, SeoCliError> =>
  Number.isFinite(value) && value > 0.5 && value < 1
    ? Effect.succeed(value)
    : Effect.fail(
        new SeoCliError({
          message: "--threshold must be greater than 0.5 and less than 1 (a review band needs 1 - t < t)",
        }),
      );

/** Read the candidate JSON from a file argument or stdin; a TTY with no file is an error. */
const readCandidatesText = (file: string | undefined): Effect.Effect<string, SeoCliError> =>
  Effect.try({
    try: () => {
      if (file !== undefined) return readFileSync(file, "utf8");
      if (process.stdin.isTTY) {
        throw new Error("no candidate file given and stdin is a TTY");
      }
      return readFileSync(0, "utf8");
    },
    catch: (cause) =>
      new SeoCliError({ message: `Could not read candidates: ${messageOf(cause)}` }),
  });

/** Parse and schema-decode the candidate array; both steps are user input. */
const parseCandidates = (text: string): Effect.Effect<ReadonlyArray<LinkCandidate>, SeoCliError> =>
  Effect.try({
    try: () => decodeLinkCandidates(JSON.parse(text)),
    catch: (cause) => new SeoCliError({ message: `Invalid candidates: ${messageOf(cause)}` }),
  });

/** TypeSafe System One decision model over the shared fetch HTTP client. */
const typeSafeDecisionModel = (
  model: string,
): Layer.Layer<DecisionModel.DecisionModel, Config.ConfigError> =>
  TypeSafeDecisionModel.model(model).pipe(
    Layer.provide(TypeSafeClient.layerConfig()),
    Layer.provide(FetchHttpClient.layer),
  );

const decisionErrorMessage = (error: AiError.AiError | Config.ConfigError): SeoCliError =>
  error._tag === "AiError"
    ? new SeoCliError({
        message: `Decision request failed (${error.reason._tag}): ${error.message}`,
      })
    : new SeoCliError({ message: `TypeSafe configuration failed: ${error.message}` });

const linksDecideCommand = Command.make("decide", {
  file: decideFile,
  json: jsonFlag,
  threshold: thresholdFlag,
  model: modelFlag,
  concurrency: concurrencyFlag,
}).pipe(
  Command.withDescription(
    "Answer real-reason and anchor-present decisions for candidate links; below-threshold candidates go to review",
  ),
  Command.withExamples([
    {
      command: "pagegraph links decide candidates.json",
      description: "Decide a candidate set and print the reviewable plan",
    },
    {
      command: "cat candidates.json | pagegraph links decide --json | jq",
      description: "Read candidates from stdin and emit versioned JSON",
    },
    {
      command: "pagegraph links decide candidates.json --threshold 0.8",
      description: "Widen the review band around the decision boundary",
    },
  ]),
  Command.withHandler(
    Effect.fn("SeoCli.linksDecide")(function* (options) {
      const threshold = yield* checkThreshold(options.threshold);
      const concurrency = yield* positive("concurrency", options.concurrency);

      const text = yield* readCandidatesText(Option.getOrUndefined(options.file));
      const candidates = yield* parseCandidates(text);

      if (process.env.TYPESAFE_API_KEY === undefined || process.env.TYPESAFE_API_KEY === "") {
        return yield* new SeoCliError({
          message:
            "TYPESAFE_API_KEY is not set; `pagegraph links decide` answers through TypeSafe System One.",
        });
      }

      const report = yield* decideLinks(candidates, {
        model: options.model,
        threshold,
        concurrency,
      }).pipe(
        Effect.provide(typeSafeDecisionModel(options.model)),
        Effect.mapError(decisionErrorMessage),
      );

      if (options.json) yield* printJson(report);
      else yield* printText(renderLinksDecideReport(report));
    }),
  ),
);

const candidatesLimitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Maximum candidates to output after ordering"),
  Flag.withDefault(50),
);
const clusterFlag = Flag.String("cluster").pipe(
  Flag.withDescription("Restrict to a cluster: a top-level section or a kind (repeatable)"),
  Flag.between(0, 64),
);
const renderedFlag = Flag.String("rendered").pipe(
  Flag.withDescription("JSON file of already-rendered edges to exclude (array or { edges })"),
  Flag.optional,
);
const decideFlag = Flag.Boolean("decide").pipe(
  Flag.withDescription("Also hand the candidate set to Jev for recommendations and confidence"),
  Flag.withDefault(false),
);

/** Read already-rendered edges from an optional JSON file; absent input is no exclusions. */
const readRenderedEdges = (
  file: string | undefined,
): Effect.Effect<ReadonlyArray<SimpleEdge>, SeoCliError> =>
  file === undefined
    ? Effect.succeed([])
    : Effect.try({
        try: () => decodeRenderedEdges(JSON.parse(readFileSync(file, "utf8"))),
        catch: (cause) =>
          new SeoCliError({
            message: `Could not read rendered edges from ${file}: ${messageOf(cause)}`,
          }),
      });

const linksCandidatesCommand = Command.make("candidates", {
  json: jsonFlag,
  limit: candidatesLimitFlag,
  cluster: clusterFlag,
  rendered: renderedFlag,
  decide: decideFlag,
  threshold: thresholdFlag,
  model: modelFlag,
  concurrency: concurrencyFlag,
}).pipe(
  Command.withDescription(
    "Propose reviewable contextual links from the declared graph, clustered and not already connected",
  ),
  Command.withExamples([
    {
      command: "pagegraph links candidates",
      description: "Propose clustered contextual-link candidates as a reviewable plan",
    },
    {
      command: "pagegraph links candidates --cluster blog --limit 20",
      description: "Only the /blog cluster, capped at 20 pairs",
    },
    {
      command: "pagegraph links candidates --rendered rendered.json --json | jq",
      description: "Exclude anchors already served, and emit versioned JSON",
    },
    {
      command: "pagegraph links candidates --decide",
      description: "Also ask Jev which candidates have a real reason (needs TYPESAFE_API_KEY)",
    },
  ]),
  Command.withHandler(
    Effect.fn("SeoCli.linksCandidates")(function* (options) {
      const limit = yield* positive("limit", options.limit);
      const threshold = yield* checkThreshold(options.threshold);
      const concurrency = yield* positive("concurrency", options.concurrency);

      const config = yield* loadSeoConfig;
      const graph = yield* Effect.scoped(acquireGraph(config));
      const renderedEdges = yield* readRenderedEdges(Option.getOrUndefined(options.rendered));

      const result = generateLinkCandidates(graph, {
        limit,
        clusters: options.cluster,
        renderedEdges,
      });

      let decisions: LinksDecideReport | null = null;
      if (options.decide) {
        if (process.env.TYPESAFE_API_KEY === undefined || process.env.TYPESAFE_API_KEY === "") {
          return yield* new SeoCliError({
            message:
              "TYPESAFE_API_KEY is not set; `--decide` answers through TypeSafe System One.",
          });
        }
        const candidates: ReadonlyArray<LinkCandidate> = result.candidates.map((pair) => {
          const node = graph.nodes.get(pair.source);
          return {
            sourceUrl: pair.source,
            destinationUrl: pair.destination,
            sourceText: node === undefined ? pair.source : candidateSourceText(node),
          };
        });
        decisions = yield* decideLinks(candidates, {
          model: options.model,
          threshold,
          concurrency,
        }).pipe(
          Effect.provide(typeSafeDecisionModel(options.model)),
          Effect.mapError(decisionErrorMessage),
        );
      }

      const report: LinksCandidatesReport = {
        kind: "links-candidates",
        schemaVersion: 1,
        limit,
        total: result.total,
        truncated: result.truncated,
        clusters: result.clusters,
        candidates: result.candidates,
        rendered: Option.isSome(options.rendered),
        decisions,
      };

      if (options.json) yield* printJson(report);
      else yield* printText(renderLinksCandidatesReport(report));
    }),
  ),
);

/**
 * `pagegraph links` groups link-graph capabilities. `verify` crawls served HTML
 * and reports what a crawler actually receives; `candidates` proposes contextual
 * links from the declared graph; `decide` answers the link decisions over a
 * candidate set through TypeSafe System One.
 */
export const linksCommand = Command.make("links").pipe(
  Command.withDescription("Rendered link-graph verification, candidate generation, and link decisions"),
  Command.withSubcommands([linksVerifyCommand, linksCandidatesCommand, linksDecideCommand]),
);
