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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";

import { crawlRenderedPages } from "../../audit/crawl";
import { checkRenderedCoverage, type CoverageRule, type Violation } from "../../core/checks";
import {
  candidateSourceText,
  decodeRenderedEdges,
  generateLinkCandidates,
} from "../../core/link-candidates";
import {
  buildRenderedGraph,
  decodeRenderedEdgeArtifact,
  diffLinkGraph,
  RENDERED_EDGE_ARTIFACT_SCHEMA_VERSION,
  renderedGraphFromEdges,
  type LinkEdge,
  type RenderedEdgeArtifact,
  type RenderedGraph,
  type SimpleEdge,
} from "../../core/links";
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
  type LinksCoverageReport,
  type LinksVerifyReport,
} from "../render";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const positive = (name: string, value: number): Effect.Effect<number, SeoCliError> =>
  Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(new SeoCliError({ message: `--${name} must be a positive integer` }));

const urlArg = Argument.String("url").pipe(
  Argument.withDescription(
    "Absolute http(s) URL of the site homepage to crawl (omit with --rendered)",
  ),
  Argument.optional,
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

/** Rendered coverage rules with the outcome of asserting them against a crawl. */
interface CoverageOutcome {
  readonly rules: number;
  readonly violations: ReadonlyArray<Violation>;
}

/** What `verify` derives from the app's `seo.config.ts`, if one exists. */
interface DeclaredAnalysis {
  /** Declared `related` edges, for the declared-vs-rendered diff. */
  readonly declaredEdges: ReadonlyArray<SimpleEdge> | undefined;
  /** Present only under `--assert-coverage`. */
  readonly coverage: CoverageOutcome | undefined;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Load the app's declared graph when a `seo.config.ts` exists and derive the two
 * things `verify` needs from it: the declared `related` edges for the diff, and —
 * under `--assert-coverage` — the rendered coverage assertion. Both are computed
 * inside one scoped graph acquisition so the Vite loader is acquired once.
 *
 * Without `--assert-coverage` the declared graph is optional enrichment: a
 * missing or broken config, an invalid origin, or an origin mismatch each become a
 * warning, because verifying served HTML works on any deployed site. Under
 * `--assert-coverage` every one of those is a hard failure — an assertion must
 * know which pages the rules target and that this crawl is the same site, and a
 * truncated crawl is refused before the graph is even loaded.
 */
const analyzeDeclared = (
  crawlOrigin: string,
  renderedEdges: ReadonlyArray<LinkEdge>,
  assertCoverage: boolean,
  crawlState: { readonly truncated: boolean; readonly bodyTruncated: boolean },
): Effect.Effect<DeclaredAnalysis, SeoCliError> =>
  Effect.gen(function* () {
    if (assertCoverage) {
      if (crawlState.truncated) {
        return yield* new SeoCliError({
          message:
            "Refusing to assert rendered coverage on a truncated crawl; re-run with a higher --limit.",
        });
      }
      if (crawlState.bodyTruncated) {
        return yield* new SeoCliError({
          message:
            "Refusing to assert rendered coverage when a crawled body was truncated; raise --max-body-bytes.",
        });
      }
    }

    const warnings: Array<string> = [];
    const config = yield* loadSeoConfigOptional.pipe(
      Effect.catchTag("SeoCliError", (error) =>
        assertCoverage
          ? Effect.fail(error)
          : Effect.sync(() => {
              warnings.push(`Ignoring declared graph: ${error.message}`);
              return undefined;
            }),
      ),
    );

    if (config === undefined) {
      if (assertCoverage) {
        return yield* new SeoCliError({
          message: "Coverage assertion needs a seo.config.ts declaring `coverage` rules.",
        });
      }
      return { declaredEdges: undefined, coverage: undefined, warnings };
    }

    let configOrigin: string;
    try {
      configOrigin = new URL(config.origin).origin;
    } catch {
      const message = `Ignoring declared graph: seo.config.ts origin "${config.origin}" is not a valid URL.`;
      if (assertCoverage) return yield* new SeoCliError({ message });
      warnings.push(message);
      return { declaredEdges: undefined, coverage: undefined, warnings };
    }

    const rules: ReadonlyArray<CoverageRule> = config.coverage ?? [];
    if (assertCoverage && rules.length === 0) {
      return yield* new SeoCliError({
        message: "seo.config.ts declares no `coverage` rules; nothing to assert.",
      });
    }

    if (configOrigin !== crawlOrigin) {
      const mismatch = `declared graph origin ${configOrigin} differs from crawled origin ${crawlOrigin}`;
      if (assertCoverage) {
        return yield* new SeoCliError({
          message: `Cannot assert coverage: ${mismatch}.`,
        });
      }
      warnings.push(
        `${mismatch.charAt(0).toUpperCase()}${mismatch.slice(1)}; skipping the declared-vs-rendered diff.`,
      );
      return { declaredEdges: undefined, coverage: undefined, warnings };
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const graph = yield* acquireGraph(config);
        // Only `related` edges are deliberate in-copy cross-links. Breadcrumbs are
        // nav-region anchors, redirects render no anchor, and collection membership
        // is not a rendered link — diffing them against body anchors would be noise.
        const declaredEdges: ReadonlyArray<SimpleEdge> = graph.edges
          .filter((edge) => edge.type === "related")
          .map((edge): SimpleEdge => ({ from: edge.from, to: edge.to }));
        const coverage: CoverageOutcome | undefined = assertCoverage
          ? { rules: rules.length, violations: checkRenderedCoverage(graph, renderedEdges, rules) }
          : undefined;
        return { declaredEdges, coverage, warnings };
      }),
    );
  });

/** Read and decode a saved rendered-edge artifact; the file is user input. */
const readRenderedArtifact = (file: string): Effect.Effect<RenderedEdgeArtifact, SeoCliError> =>
  Effect.try({
    try: () => decodeRenderedEdgeArtifact(JSON.parse(readFileSync(file, "utf8"))),
    catch: (cause) =>
      new SeoCliError({
        message: `Could not read rendered artifact from ${file}: ${messageOf(cause)}`,
      }),
  });

/** Write a rendered-edge artifact, creating its parent directory when needed. */
const writeRenderedArtifact = (
  file: string,
  artifact: RenderedEdgeArtifact,
): Effect.Effect<void, SeoCliError> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(resolve(file)), { recursive: true });
      writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new SeoCliError({
        message: `Could not write rendered artifact to ${file}: ${messageOf(cause)}`,
      }),
  });

const emitRenderedFlag = Flag.String("emit-rendered").pipe(
  Flag.withDescription("Write the crawled rendered-edge artifact to this path (crawl mode)"),
  Flag.optional,
);
const renderedArtifactFlag = Flag.String("rendered").pipe(
  Flag.withDescription("Replay a saved rendered-edge artifact instead of crawling"),
  Flag.optional,
);
const assertCoverageFlag = Flag.Boolean("assert-coverage").pipe(
  Flag.withDescription(
    "Assert seo.config.ts coverage rules against the rendered anchors; exit 1 on unmet (refuses truncated crawls)",
  ),
  Flag.withDefault(false),
);

const linksVerifyCommand = Command.make("verify", {
  url: urlArg,
  json: jsonFlag,
  limit: limitFlag,
  allowPrivate,
  requestTimeoutMs,
  maxBodyBytes,
  emitRendered: emitRenderedFlag,
  rendered: renderedArtifactFlag,
  assertCoverage: assertCoverageFlag,
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
      command: "pagegraph links verify https://example.com --limit 25 --json | jq",
      description: "Bound the crawl to 25 pages and emit versioned JSON",
    },
    {
      command: "pagegraph links verify https://example.com --emit-rendered rendered.json",
      description: "Crawl once and save the rendered-edge artifact",
    },
    {
      command: "pagegraph links verify --rendered rendered.json --assert-coverage",
      description: "Assert seo.config.ts coverage offline against a saved crawl (exit 1 on unmet)",
    },
    {
      command: "pagegraph links verify https://example.com --assert-coverage",
      description: "Crawl and assert coverage against the served anchors in one pass",
    },
    {
      command: "pagegraph links verify http://localhost:3000 --allow-private",
      description: "Verify a local app",
    },
  ]),
  Command.withHandler(
    Effect.fn("SeoCli.linksVerify")(function* (options) {
      const emitPath = Option.getOrUndefined(options.emitRendered);
      const artifactPath = Option.getOrUndefined(options.rendered);
      const url = Option.getOrUndefined(options.url);

      if (emitPath !== undefined && artifactPath !== undefined) {
        return yield* new SeoCliError({
          message:
            "--emit-rendered writes a fresh crawl; --rendered replays one. Use one or the other.",
        });
      }
      if (url === undefined && artifactPath === undefined) {
        return yield* new SeoCliError({
          message: "Provide a homepage URL to crawl, or --rendered <path> to replay a saved crawl.",
        });
      }

      const warnings: Array<string> = [];
      let origin: string;
      let seed: string;
      let graph: RenderedGraph;
      let renderedEdges: ReadonlyArray<LinkEdge>;
      let crawlReport: LinksVerifyReport["crawl"];

      if (artifactPath !== undefined) {
        const artifact = yield* readRenderedArtifact(artifactPath);
        if (url !== undefined) {
          let requestedOrigin: string;
          try {
            requestedOrigin = new URL(url).origin;
          } catch {
            return yield* new SeoCliError({ message: `Not a valid URL: ${url}` });
          }
          if (requestedOrigin !== new URL(artifact.origin).origin) {
            return yield* new SeoCliError({
              message: `--rendered artifact origin ${artifact.origin} does not match ${url}.`,
            });
          }
        }
        origin = artifact.origin;
        seed = artifact.seed;
        graph = renderedGraphFromEdges(artifact.edges, artifact.crawl.root);
        renderedEdges = artifact.edges;
        crawlReport = {
          pages: artifact.crawl.pages,
          limit: artifact.crawl.limit,
          truncated: artifact.crawl.truncated,
          failures: [],
          bodyTruncated: artifact.crawl.bodyTruncated,
          truncatedPages: artifact.crawl.truncatedPages,
        };
      } else {
        const checkedLimit = yield* positive("limit", options.limit);
        const checkedTimeout = yield* positive("request-timeout-ms", options.requestTimeoutMs);
        const checkedMaxBody = yield* positive("max-body-bytes", options.maxBodyBytes);

        const crawl = yield* Effect.tryPromise({
          try: () =>
            crawlRenderedPages(url!, {
              limit: checkedLimit,
              timeoutMs: checkedTimeout,
              maxBodyBytes: checkedMaxBody,
              allowPrivate: options.allowPrivate,
            }),
          catch: (cause) =>
            new SeoCliError({ message: `Could not crawl ${url}: ${messageOf(cause)}` }),
        });

        if (crawl.pages.length === 0) {
          const reason = crawl.failures[0]?.error ?? "no pages fetched";
          return yield* new SeoCliError({
            message: `No page could be crawled at ${url}: ${reason}`,
          });
        }

        graph = buildRenderedGraph(crawl.origin, crawl.pages, crawl.root);
        renderedEdges = graph.internalEdges;
        origin = crawl.origin;
        seed = crawl.seed;
        crawlReport = {
          pages: crawl.pages.length,
          limit: crawl.limit,
          truncated: crawl.truncated,
          failures: crawl.failures,
          bodyTruncated: crawl.truncatedBodies.length > 0,
          truncatedPages: crawl.truncatedBodies,
        };

        if (emitPath !== undefined) {
          const artifact: RenderedEdgeArtifact = {
            kind: "links-rendered",
            schemaVersion: RENDERED_EDGE_ARTIFACT_SCHEMA_VERSION,
            origin: crawl.origin,
            seed: crawl.seed,
            crawl: {
              pages: crawl.pages.length,
              root: crawl.root,
              limit: crawl.limit,
              truncated: crawl.truncated,
              bodyTruncated: crawl.truncatedBodies.length > 0,
              truncatedPages: crawl.truncatedBodies,
            },
            edges: graph.internalEdges,
          };
          yield* writeRenderedArtifact(emitPath, artifact);
          yield* Effect.logInfo(`Wrote rendered edges to ${emitPath}`);
        }
      }

      if (crawlReport.truncatedPages.length > 0) {
        warnings.push(
          `${crawlReport.truncatedPages.length} page body/bodies exceeded --max-body-bytes; anchors past the cutoff are missing.`,
        );
      }

      const analysis = yield* analyzeDeclared(origin, renderedEdges, options.assertCoverage, {
        truncated: crawlReport.truncated,
        bodyTruncated: crawlReport.bodyTruncated,
      });
      warnings.push(...analysis.warnings);
      const diff =
        analysis.declaredEdges === undefined
          ? undefined
          : diffLinkGraph(analysis.declaredEdges, graph);
      const coverage: LinksCoverageReport | undefined =
        analysis.coverage === undefined
          ? undefined
          : {
              rules: analysis.coverage.rules,
              ok: analysis.coverage.violations.length === 0,
              violations: analysis.coverage.violations,
            };

      const report: LinksVerifyReport = {
        kind: "links-verify",
        schemaVersion: 1,
        origin,
        seed,
        crawl: crawlReport,
        rendered: {
          pages: crawlReport.pages,
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
        ...(coverage === undefined ? {} : { coverage }),
        warnings,
      };

      if (options.json) yield* printJson(report);
      else yield* printText(renderLinksReport(report));

      if (coverage !== undefined && !coverage.ok) {
        return yield* new SeoCliError({
          message: `${coverage.violations.length} rendered coverage violation(s) — the served anchors do not satisfy seo.config.ts.`,
        });
      }
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
