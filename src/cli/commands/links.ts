import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { allowedByRobots, crawlRenderedPages, robotsRules } from "../../audit/crawl";
import { probeHttp } from "../../audit/scanners/http";
import { checkRenderedCoverage, type CoverageRule, type Violation } from "../../core/checks";
import { decodeRenderedEdges, generateLinkCandidates } from "../../core/link-candidates";
import { extractPageSentences, rankLinkSuggestions, selectSuggestionPages, type LinksSuggestionReport } from "../../core/link-suggestions";
import {
  buildRenderedGraph,
  decodeRenderedEdgeArtifact,
  diffLinkGraph,
  RENDERED_EDGE_ARTIFACT_SCHEMA_VERSION,
  renderedGraphFromEdges,
  normalizePath,
  type LinkEdge,
  type RenderedEdgeArtifact,
  type RenderedGraph,
  type SimpleEdge,
} from "../../core/links";
import { isSitemapEligible } from "../../core/projections";
import { acquireGraph, loadSeoConfig, loadSeoConfigOptional } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";
import {
  renderLinksCandidatesReport,
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
  crawlState: {
    readonly truncated: boolean;
    readonly bodyTruncated: boolean;
    readonly failures: number;
    readonly discoveryFailures: number;
    readonly sitemapTruncated: boolean;
    readonly nonHtml: ReadonlyArray<{ readonly url: string; readonly finalUrl: string; readonly contentType: string }>;
  },
): Effect.Effect<DeclaredAnalysis, SeoCliError> =>
  Effect.gen(function* () {
    if (assertCoverage) {
      if (crawlState.truncated) {
        return yield* new SeoCliError({
          message:
            "Refusing to assert rendered coverage on a truncated crawl; re-run with a higher --limit.",
        });
      }
      if (crawlState.failures > 0) {
        return yield* new SeoCliError({
          message: `Refusing to assert rendered coverage: ${crawlState.failures} page(s) failed to fetch, so their anchors are missing.`,
        });
      }
      if (crawlState.discoveryFailures > 0 || crawlState.sitemapTruncated) {
        return yield* new SeoCliError({
          message: "Refusing to assert rendered coverage: sitemap or robots discovery was incomplete.",
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
        if (assertCoverage && crawlState.nonHtml.length > 0) {
          const declaredPaths = new Set([...graph.nodes.values()].filter(isSitemapEligible).map((node) => normalizePath(new URL(node.path, crawlOrigin))));
          const missed = crawlState.nonHtml.find((item) =>
            declaredPaths.has(normalizePath(new URL(item.url))) || declaredPaths.has(normalizePath(new URL(item.finalUrl))));
          if (missed !== undefined) {
            return yield* new SeoCliError({ message: `Refusing to assert rendered coverage: declared page ${missed.url} served non-HTML content.` });
          }
        }
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
        graph = renderedGraphFromEdges(artifact.edges, artifact.crawl.root, artifact.nodes);
        renderedEdges = artifact.edges;
        crawlReport = {
          pages: artifact.crawl.pages,
          limit: artifact.crawl.limit,
          truncated: artifact.crawl.truncated,
          failures: artifact.crawl.failures,
          ...(artifact.crawl.nonHtml === undefined ? {} : { nonHtml: artifact.crawl.nonHtml }),
          bodyTruncated: artifact.crawl.bodyTruncated,
          truncatedPages: artifact.crawl.truncatedPages,
          ...(artifact.crawl.discoveryFailures === undefined ? {} : { discoveryFailures: artifact.crawl.discoveryFailures }),
          ...(artifact.crawl.skipped === undefined ? {} : { skipped: artifact.crawl.skipped }),
          ...(artifact.crawl.sitemapTruncated === undefined ? {} : { sitemapTruncated: artifact.crawl.sitemapTruncated }),
          ...(artifact.crawl.sitemapUsed === undefined ? {} : { sitemapUsed: artifact.crawl.sitemapUsed }),
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
          nonHtml: crawl.nonHtml,
          bodyTruncated: crawl.truncatedBodies.length > 0,
          truncatedPages: crawl.truncatedBodies,
          discoveryFailures: crawl.discoveryFailures,
          skipped: crawl.skipped,
          sitemapTruncated: crawl.sitemapTruncated,
          sitemapUsed: crawl.sitemapUsed,
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
              failures: crawl.failures,
              nonHtml: crawl.nonHtml,
              discoveryFailures: crawl.discoveryFailures,
              skipped: crawl.skipped,
              sitemapTruncated: crawl.sitemapTruncated,
              sitemapUsed: crawl.sitemapUsed,
            },
            nodes: graph.nodes,
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
      if ((crawlReport.discoveryFailures?.length ?? 0) > 0 || crawlReport.sitemapTruncated === true) {
        warnings.push("Sitemap or robots discovery was incomplete; rendered coverage cannot be asserted.");
      }
      if ((crawlReport.nonHtml?.length ?? 0) > 0) {
        warnings.push(`${crawlReport.nonHtml!.length} link-only URL(s) served non-HTML and were skipped.`);
      }

      const analysis = yield* analyzeDeclared(origin, renderedEdges, options.assertCoverage, {
        truncated: crawlReport.truncated,
        bodyTruncated: crawlReport.bodyTruncated,
        failures: crawlReport.failures.length,
        discoveryFailures: crawlReport.discoveryFailures?.length ?? 0,
        sitemapTruncated: crawlReport.sitemapTruncated ?? false,
        nonHtml: crawlReport.nonHtml ?? [],
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
const siteFlag = Flag.String("site").pipe(
  Flag.withDescription("Opt in to same-origin served-content suggestions"),
  Flag.optional,
);
const pageLimitFlag = Flag.Int("page-limit").pipe(
  Flag.withDescription("Maximum declared pages to probe for content (default 25)"),
  Flag.withDefault(25),
);
const targetFlag = Flag.String("target").pipe(
  Flag.withDescription("Prioritize an exact target page path (repeatable)"),
  Flag.between(0, 64),
);
const sourceFlag = Flag.String("source").pipe(
  Flag.withDescription("Prioritize an exact source page path (repeatable)"),
  Flag.between(0, 64),
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
  site: siteFlag,
  pageLimit: pageLimitFlag,
  target: targetFlag,
  source: sourceFlag,
  allowPrivate,
  requestTimeoutMs,
  maxBodyBytes,
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
      command: "pagegraph links candidates --site https://example.com --json",
      description: "Rank verifiable sentence-and-anchor suggestions from served pages",
    },
    {
      command: "pagegraph links candidates --site https://example.com --target /blog/weak --json",
      description: "Probe a weak target and its candidate source pages first",
    },
  ]),
  Command.withHandler(
    Effect.fn("SeoCli.linksCandidates")(function* (options) {
      const limit = yield* positive("limit", options.limit);
      const pageLimit = yield* positive("page-limit", options.pageLimit);
      if (Option.isSome(options.site) && (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1 || options.maxBodyBytes > 10_000_000)) {
        return yield* new SeoCliError({ message: "--max-body-bytes must be between 1 and 10000000 in site mode" });
      }

      const config = yield* loadSeoConfig;
      const graph = yield* Effect.scoped(acquireGraph(config));
      const renderedEdges = yield* readRenderedEdges(Option.getOrUndefined(options.rendered));

      const site = Option.getOrUndefined(options.site);
      if (site !== undefined) {
        const report = yield* Effect.tryPromise({
          try: async (): Promise<LinksSuggestionReport> => {
            const target = new URL(site);
            const configured = new URL(config.origin);
            if (!["http:", "https:"].includes(target.protocol) || target.origin !== configured.origin) {
              throw new Error(`--site origin must match seo.config.ts (${configured.origin})`);
            }
            const requestedTargets = new Set(options.target);
            const requestedSources = new Set(options.source);
            const nodes = [...graph.nodes.values()].filter(isSitemapEligible);
            const selected = selectSuggestionPages(graph, { pageLimit, targets: requestedTargets, sources: requestedSources, clusters: options.cluster, renderedEdges });
            const selectedPaths = new Set(selected.map((node) => node.path));
            const skipped: Array<{ path: string; reason: string }> = nodes.filter((node) => !selectedPaths.has(node.path)).map((node) => ({ path: node.path, reason: "page limit or target filter" }));
            const robots = await probeHttp({ kind: "robots", method: "GET", accept: "text/plain", url: new URL("/robots.txt", configured) }, {
              sameOrigin: configured.origin, allowPrivate: options.allowPrivate, timeoutMs: options.requestTimeoutMs,
              maxBodyBytes: options.maxBodyBytes, captureBody: true,
            });
            if ((!robots.ok && robots.status !== 404) || robots.bodyTruncated) {
              throw new Error("Could not establish complete robots policy for the site");
            }
            const rules = robots.ok ? robotsRules(robots.body ?? "").rules : [];
            const pages: Array<{ path: string; sentences: ReadonlyArray<string> }> = [];
            const observed: Array<{ from: string; to: string; region: "nav" | "header" | "footer" | "body" }> = [];
            for (const node of selected) {
              if (!allowedByRobots(node.path, rules)) { skipped.push({ path: node.path, reason: "robots disallow" }); continue; }
              const url = new URL(node.path, configured);
              const probe = await probeHttp({ kind: "page-html", method: "GET", accept: "text/html", url }, {
                sameOrigin: configured.origin,
                allowPrivate: options.allowPrivate,
                timeoutMs: options.requestTimeoutMs,
                maxBodyBytes: options.maxBodyBytes,
                captureAnchors: true,
                captureBody: true,
                allowUrl: (next) => allowedByRobots(`${next.pathname}${next.search}`, rules),
              });
              const contentType = probe.responseHeaders["content-type"];
              if (!probe.ok || probe.bodyTruncated || (contentType !== undefined && !/text\/html|application\/xhtml\+xml/i.test(contentType)) || !probe.body || !probe.finalUrl || new URL(probe.finalUrl).pathname.replace(/\/+$/, "") !== node.path.replace(/\/+$/, "")) {
                skipped.push({ path: node.path, reason: probe.error ?? (probe.bodyTruncated ? "body truncated" : "unreadable or redirected page") });
                continue;
              }
              const sentences = extractPageSentences(probe.body);
              if (sentences.length === 0) { skipped.push({ path: node.path, reason: "no readable main content" }); continue; }
              pages.push({ path: node.path, sentences });
              for (const anchor of probe.anchors ?? []) {
                if (!anchor.internal) continue;
                observed.push({ from: node.path, to: new URL(anchor.href).pathname.replace(/\/+$/, "") || "/", region: anchor.region });
              }
            }
            const readablePaths = new Set(pages.map((page) => page.path));
            const scopedGraph = { ...graph, nodes: new Map([...graph.nodes].filter(([path]) => readablePaths.has(path))),
              edges: graph.edges.filter((edge) => readablePaths.has(edge.from) && readablePaths.has(edge.to)) };
            const pairs = generateLinkCandidates(scopedGraph, { clusters: options.cluster, limit: Number.MAX_SAFE_INTEGER, renderedEdges: [...renderedEdges, ...observed] }).candidates
              .filter((pair) => (requestedTargets.size === 0 || requestedTargets.has(pair.destination))
                && (requestedSources.size === 0 || requestedSources.has(pair.source)));
            const inbound = new Map<string, number>();
            for (const edge of [...graph.edges.filter((edge) => edge.type === "related"), ...observed.filter((edge) => edge.region === "body")]) {
              inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
            }
            const ranked = rankLinkSuggestions(pairs, pages, inbound, limit);
            return { kind: "links-candidates", schemaVersion: 2, origin: configured.origin, limit, pageLimit, maxBodyBytes: options.maxBodyBytes, total: ranked.total,
              truncated: ranked.total > ranked.candidates.length || skipped.some((item) => item.reason === "page limit or target filter"),
              skipped, candidates: ranked.candidates };
          },
          catch: (cause) => new SeoCliError({ message: `Could not produce site suggestions: ${messageOf(cause)}` }),
        });
        if (options.json) yield* printJson(report);
        else yield* printText(`${report.total} content-backed suggestion(s) · ${report.skipped.length} page(s) skipped\n\n${report.candidates.map((item) => `${item.source} → ${item.destination} (score ${item.score})\n  ${item.sentence}\n  Anchor: ${item.anchor}\n  Target: ${item.targetSentence}\n  ${item.reason}`).join("\n\n")}`);
        return;
      }

      const result = generateLinkCandidates(graph, {
        limit,
        clusters: options.cluster,
        renderedEdges,
      });

      const report: LinksCandidatesReport = {
        kind: "links-candidates",
        schemaVersion: 1,
        limit,
        total: result.total,
        truncated: result.truncated,
        clusters: result.clusters,
        candidates: result.candidates,
        rendered: Option.isSome(options.rendered),
      };

      if (options.json) yield* printJson(report);
      else yield* printText(renderLinksCandidatesReport(report));
    }),
  ),
);

/**
 * `pagegraph links` groups link-graph capabilities. `verify` crawls served HTML
 * and reports what a crawler actually receives; `candidates` proposes contextual
 * links from the declared graph for workflow-level review.
 */
export const linksCommand = Command.make("links").pipe(
  Command.withDescription("Rendered link-graph verification and candidate generation"),
  Command.withSubcommands([linksVerifyCommand, linksCandidatesCommand]),
);
