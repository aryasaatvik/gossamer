/**
 * `pagegraph/config` — the `pagegraph` CLI's configuration surface.
 *
 * The CLI is a set of pure views over one graph, but *acquiring* that graph is
 * host knowledge: only the app knows where its graph module lives and what its
 * module needs to evaluate. So the app declares it once in a `seo.config.ts` at
 * its root, which the CLI discovers from the working directory:
 *
 * ```ts
 * // seo.config.ts
 * import { defineSeoConfig, viteGraphLoader } from "pagegraph/config";
 * import { routeConfig } from "./lib/route-config";
 *
 * export default defineSeoConfig({
 *   origin: "https://example.com",
 *   disallow: routeConfig.robotsExclusions,
 *   contentSignal: "search=yes, ai-input=yes, ai-train=yes",
 *   loadGraph: viteGraphLoader({ root: import.meta.dirname, entry: "/lib/seo/graph.ts" }),
 * });
 * ```
 *
 * Nothing here imports Effect. The CLI needs it (an optional peer dependency),
 * but a config file must not: it is the app's file, and the app may not be an
 * Effect app.
 */

export type { LoadedSeoGraph, SeoGraphLoader, ViteGraphLoaderOptions } from "./vite-graph-loader";
export { viteGraphLoader } from "./vite-graph-loader";

import type { CoverageRule } from "../core/checks";
import type { SeoGraphLoader } from "./vite-graph-loader";

export interface SeoWorkflowOpenCodeConfig {
  /** Project-owned OpenCode configuration directory, relative to the project root. */
  readonly configDirectory: string;
  /** Default `provider/model` used by agentic workflows. */
  readonly defaultModel: string;
  /** Per-workflow `provider/model` overrides. */
  readonly models?: Readonly<Record<string, string>> | undefined;
  /** Per-completion deadline in milliseconds, including JSON repair; defaults to 180000. */
  readonly timeoutMs?: number | undefined;
}

export interface SeoWorkflowContextConfig {
  /** Durable project context included in every workflow prompt. */
  readonly files?: ReadonlyArray<string> | undefined;
  /** Additional context files keyed by workflow id. */
  readonly byWorkflow?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
}

export interface SeoWorkflowConfig {
  readonly opencode: SeoWorkflowOpenCodeConfig;
  readonly context?: SeoWorkflowContextConfig | undefined;
  /** Ignored run-artifact directory, relative to the project root. */
  readonly runsDirectory?: string | undefined;
}

export interface SeoCliConfig {
  /**
   * Canonical origin the sitemap and robots projections render under, no
   * trailing slash. The `--origin` flag overrides it per invocation.
   */
  readonly origin: string;
  /**
   * Path prefixes disallowed in robots.txt. Feed it the generated
   * `routeConfig.robotsExclusions` if you run the `pagegraph/vite` plugin.
   */
  readonly disallow: ReadonlyArray<string>;
  /**
   * Origin-wide Content-Signal preferences, forwarded to `renderRobots`.
   * Omit for none. Preview (`--no-indexable`) never emits the line.
   */
  readonly contentSignal?: string | undefined;
  /**
   * Extra robots.txt group lines, forwarded to `renderRobots` as `directives`.
   */
  readonly directives?: ReadonlyArray<string> | undefined;
  /**
   * Last-mile robots.txt override, forwarded to `renderRobots` as `transform`.
   * Runs for indexable and preview hosts.
   */
  readonly transform?: ((robots: string) => string) | undefined;
  /**
   * Contextual-link coverage policy for `pagegraph check`: every sitemap-eligible
   * page matching a rule's `path` glob needs at least `minInbound` incoming
   * `related` edges. A `--require-inbound` flag overrides this per invocation.
   */
  readonly coverage?: ReadonlyArray<CoverageRule> | undefined;
  /** Agentic workflow host, context, and artifact settings. */
  readonly workflows?: SeoWorkflowConfig | undefined;
  /** How the CLI gets the graph. {@link viteGraphLoader} covers the Vite-app case. */
  readonly loadGraph: SeoGraphLoader;
}

/** Identity — it exists for the type inference and the editor completions. */
export const defineSeoConfig = (config: SeoCliConfig): SeoCliConfig => config;
