/**
 * The SEO check engine: a set of rules run against the derived {@link SeoGraph}.
 * Pure — no I/O, no `clientEnv`, no React. The CLI's `pagegraph check` command and the
 * vitest suite both call {@link checkGraph}; nothing else derives correctness.
 *
 * Two severities, mapped to the CLI's exit contract:
 *  - `structural` — a declaration is internally broken (a link points nowhere, a
 *    card would render empty, a page contradicts its own robots/sitemap intent).
 *    Any structural violation fails `pagegraph check` (exit 1); these must not ship.
 *  - `editorial` — a quality smell (duplicate or mis-sized titles/descriptions).
 *    Reported as warnings; `pagegraph check` still exits 0 when only these are present.
 *
 * The graph only knows what declarations and frontmatter carry, so the rules are
 * scoped to that: per-node title/description live only on collection *instances*,
 * never on structural route nodes (whose head tags are composed at render time and
 * are not in the graph). Rules are data-driven and listed once in
 * {@link CHECK_RULES}.
 */

import type { SitemapPolicy } from "./declare";
import type { SeoGraph, SeoNode } from "./graph";
import type { LinkEdge } from "./links";
import { isSitemapEligible } from "./projections";

export type Severity = "structural" | "editorial";

export interface Violation {
  severity: Severity;
  rule: string;
  path?: string | undefined;
  message: string;
  fix?: string | undefined;
}

/**
 * A contextual-link coverage rule: every sitemap-eligible page matching the
 * `path` glob must have at least `minInbound` incoming contextual links. Unlike
 * the static rules, these come from project policy (a CLI flag or
 * `seo.config.ts`), because "which pages are money pages" is app knowledge.
 *
 * The same rule shape is evaluated twice: `checkCoverage` counts declared
 * `related` edges, and `checkRenderedCoverage` counts the contextual anchors a
 * crawl actually served. The target universe is always the declared graph's
 * sitemap-eligible pages — the rendered pass only swaps the edge source.
 */
export interface CoverageRule {
  /** Path glob: `*` matches within a segment, `**` matches across segments. */
  readonly path: string;
  /** Minimum incoming contextual links the matched page needs. */
  readonly minInbound: number;
}

/** A single finding before its rule's `severity`/`rule` name are attached. */
interface RawViolation {
  path?: string | undefined;
  message: string;
  fix?: string | undefined;
}

interface CheckRule {
  readonly name: string;
  readonly severity: Severity;
  readonly evaluate: (graph: SeoGraph) => ReadonlyArray<RawViolation>;
}

/** A positive sitemap policy — the author asked for this page to be indexed. */
const hasPositiveSitemap = (sitemap: SitemapPolicy | false | undefined): sitemap is SitemapPolicy =>
  sitemap !== undefined && sitemap !== false;

/** Content and manifest instances carry page-level title/description. */
const isInstance = (node: SeoNode): boolean => node.source !== "route";

/** Group instance nodes by a present, non-empty string field for duplicate detection. */
const groupInstancesBy = (
  graph: SeoGraph,
  field: (node: SeoNode) => string | undefined,
): Map<string, Array<SeoNode>> => {
  const groups = new Map<string, Array<SeoNode>>();
  for (const node of graph.nodes.values()) {
    if (!isInstance(node)) continue;
    const value = field(node)?.trim();
    if (!value) continue;
    const bucket = groups.get(value);
    if (bucket) bucket.push(node);
    else groups.set(value, [node]);
  }
  return groups;
};

const DESCRIPTION_MAX = 160;
const DESCRIPTION_MIN = 50;

/**
 * Every check, in one place. `checkGraph` runs them in order and stamps each
 * finding with its rule name and severity, so the output is grouped by rule and
 * deterministic (nodes iterate in graph insertion order, edges in array order).
 */
const CHECK_RULES: ReadonlyArray<CheckRule> = [
  {
    name: "path-owner-collision",
    severity: "structural",
    evaluate: (graph) =>
      (graph.collisions ?? []).map((collision) => ({
        path: collision.path,
        message: `Canonical path "${collision.path}" is owned by multiple sources: ${collision.sources.join(", ")}.`,
        fix: "Give every concrete page one canonical path and one graph owner.",
      })),
  },
  {
    name: "canonical-path-collision",
    severity: "structural",
    evaluate: (graph) => {
      const groups = new Map<string, Array<string>>();
      for (const path of graph.nodes.keys()) {
        const canonical = path.toLowerCase().replace(/\/$/, "") || "/";
        const paths = groups.get(canonical);
        if (paths) paths.push(path);
        else groups.set(canonical, [path]);
      }
      return [...groups.values()]
        .filter((paths) => paths.length > 1)
        .flatMap((paths) =>
          paths.map((path) => ({
            path,
            message: `Canonical path collides with ${paths.filter((candidate) => candidate !== path).join(", ")}.`,
            fix: "Use one lowercase, trailing-slash-normalized canonical path.",
          })),
        );
    },
  },
  {
    name: "self-edge",
    severity: "structural",
    evaluate: (graph) =>
      graph.edges
        .filter((edge) => edge.from === edge.to)
        .map((edge) => ({
          path: edge.from,
          message: `${edge.type} edge points back to its own source node.`,
          fix: "Remove the self-reference from the canonical manifest or route declaration.",
        })),
  },
  {
    name: "duplicate-edge",
    severity: "structural",
    evaluate: (graph) => {
      const seen = new Set<string>();
      const duplicates: Array<RawViolation> = [];
      for (const edge of graph.edges) {
        const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
        if (seen.has(key)) {
          duplicates.push({
            path: edge.from,
            message: `Duplicate ${edge.type} edge from "${edge.from}" to "${edge.to}".`,
            fix: "Declare each graph relationship exactly once.",
          });
        } else {
          seen.add(key);
        }
      }
      return duplicates;
    },
  },
  {
    // A `related` or `redirect` edge points at a path with no node — the target
    // route/page was renamed or deleted and the declaration wasn't updated.
    name: "dead-edge",
    severity: "structural",
    evaluate: (graph) =>
      graph.edges
        .filter((edge) => edge.type !== "crumb-parent" && !graph.nodes.has(edge.to))
        .map((edge) => ({
          path: edge.from,
          message: `${edge.type} edge from "${edge.from}" points at "${edge.to}", which is not a node in the graph.`,
          fix: `Update the ${edge.type === "redirect" ? "redirectTo" : "related"} target on the "${edge.from}" route, or restore "${edge.to}".`,
        })),
  },
  {
    // A content instance with no usable title can't render a legible <title> or card.
    name: "instance-missing-title",
    severity: "structural",
    evaluate: (graph) =>
      [...graph.nodes.values()]
        .filter((node) => isInstance(node) && !node.instance?.title.trim())
        .map((node) => ({
          path: node.path,
          message: `Content page "${node.path}" has no title.`,
          fix: "Add a `title` to the page frontmatter.",
        })),
  },
  {
    // The declaration asks for the page to be in the sitemap yet also marks it
    // noindex — contradictory intent. The projection resolves it (noindex wins,
    // excluded), but the declaration should say one thing.
    name: "sitemap-noindex-contradiction",
    severity: "structural",
    evaluate: (graph) =>
      [...graph.nodes.values()]
        .filter(
          (node) =>
            hasPositiveSitemap(node.policy.sitemap) &&
            node.policy.robots?.toLowerCase().includes("noindex"),
        )
        .map((node) => ({
          path: node.path,
          message: `"${node.path}" declares a sitemap policy but its robots value is "${node.policy.robots}".`,
          fix: "Drop the sitemap policy (or set `sitemap: false`) on a noindex page, or remove the noindex robots value.",
        })),
  },
  {
    // Robots declarations are house-convention lowercase: the sitemap projection
    // matches `includes("noindex")` literally, so a miscased value ("Noindex")
    // would silently stay sitemap-eligible. This gate makes that unrepresentable.
    name: "robots-not-lowercase",
    severity: "structural",
    evaluate: (graph) =>
      [...graph.nodes.values()]
        .filter(
          (node) =>
            node.policy.robots !== undefined &&
            node.policy.robots !== node.policy.robots.toLowerCase(),
        )
        .map((node) => ({
          path: node.path,
          message: `"${node.path}" declares robots "${node.policy.robots}" — robots values must be lowercase.`,
          fix: 'Lowercase the robots declaration (e.g. "noindex, follow").',
        })),
  },
  {
    // A `related` card for a route target renders from that route's `link`
    // metadata; without it the card has no title/description and renders empty.
    // (Content-instance targets render from their frontmatter, so they're exempt.)
    name: "related-target-missing-link",
    severity: "structural",
    evaluate: (graph) => {
      const linklessTargets = new Set<string>();
      for (const edge of graph.edges) {
        if (edge.type !== "related") continue;
        const target = graph.nodes.get(edge.to);
        if (target && target.source === "route" && target.policy.link === undefined) {
          linklessTargets.add(edge.to);
        }
      }
      return [...linklessTargets].map((path) => ({
        path,
        message: `Route "${path}" is a related-link target but declares no link metadata; its card would render empty.`,
        fix: `Add \`link: { title, description }\` to the "${path}" route's staticData.seo.`,
      }));
    },
  },
  {
    // A redirect/alias node should never advertise itself in the sitemap.
    name: "redirect-in-sitemap",
    severity: "structural",
    evaluate: (graph) =>
      [...graph.nodes.values()]
        .filter(
          (node) => node.policy.redirectTo !== undefined && hasPositiveSitemap(node.policy.sitemap),
        )
        .map((node) => ({
          path: node.path,
          message: `Redirect "${node.path}" (→ "${node.policy.redirectTo}") also declares a sitemap policy.`,
          fix: "Remove the sitemap policy from the redirect route; only its target belongs in the sitemap.",
        })),
  },
  {
    name: "duplicate-title",
    severity: "editorial",
    evaluate: (graph) =>
      [...groupInstancesBy(graph, (node) => node.instance?.title).entries()]
        .filter(([, nodes]) => nodes.length > 1)
        .flatMap(([title, nodes]) =>
          nodes.map((node) => ({
            path: node.path,
            message: `Title "${title}" is shared by ${nodes.length} pages.`,
            fix: "Give each page a distinct title.",
          })),
        ),
  },
  {
    name: "duplicate-description",
    severity: "editorial",
    evaluate: (graph) =>
      [...groupInstancesBy(graph, (node) => node.instance?.description).entries()]
        .filter(([, nodes]) => nodes.length > 1)
        .flatMap(([, nodes]) =>
          nodes.map((node) => ({
            path: node.path,
            message: `Description is shared by ${nodes.length} pages.`,
            fix: "Write a distinct meta description for each page.",
          })),
        ),
  },
  {
    // Meta descriptions outside ~50–160 chars either get truncated in SERPs or
    // read as too thin.
    name: "description-length",
    severity: "editorial",
    evaluate: (graph) =>
      [...graph.nodes.values()].flatMap((node) => {
        if (!isInstance(node)) return [];
        const description = node.instance?.description?.trim();
        if (!description) return [];
        if (description.length > DESCRIPTION_MAX) {
          return [
            {
              path: node.path,
              message: `Description is ${description.length} chars (max ${DESCRIPTION_MAX}); it will be truncated in results.`,
              fix: `Trim the description to ${DESCRIPTION_MAX} characters or fewer.`,
            },
          ];
        }
        if (description.length < DESCRIPTION_MIN) {
          return [
            {
              path: node.path,
              message: `Description is ${description.length} chars (min ${DESCRIPTION_MIN}); it reads as thin.`,
              fix: `Expand the description to at least ${DESCRIPTION_MIN} characters.`,
            },
          ];
        }
        return [];
      }),
  },
];

/**
 * Run every static rule against the graph, then any caller-supplied
 * {@link CoverageRule}s, and return the flat list of violations. With no
 * `coverage` option the result is exactly the static rule set.
 */
export function checkGraph(
  graph: SeoGraph,
  options: { readonly coverage?: ReadonlyArray<CoverageRule> | undefined } = {},
): Array<Violation> {
  const violations: Array<Violation> = CHECK_RULES.flatMap((rule) =>
    rule.evaluate(graph).map((raw): Violation => ({
      severity: rule.severity,
      rule: rule.name,
      path: raw.path,
      message: raw.message,
      fix: raw.fix,
    })),
  );
  const coverage = options.coverage;
  if (coverage !== undefined && coverage.length > 0) {
    violations.push(...checkCoverage(graph, coverage));
  }
  return violations;
}

/** Escape a glob for `RegExp`, then expand `**`, `*`, and `?` to path-aware forms. */
const globToRegExp = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
};

/**
 * The minimal view a coverage rule needs: which paths exist (for the glob), which
 * of them are sitemap-eligible (the enforced set), and how many contextual links
 * each receives. Declared and rendered coverage differ only in how this surface
 * is built, so the rule engine itself stays single-sourced.
 */
interface CoverageSurface {
  readonly paths: ReadonlyArray<string>;
  readonly eligiblePaths: ReadonlyArray<string>;
  readonly inbound: (path: string) => number;
}

/**
 * Enforce contextual-link coverage rules over an explicit surface.
 *
 * A rule that matches no sitemap-eligible page is itself a violation: a typo or
 * a rule aimed at a noindex page would otherwise pass silently forever.
 */
const checkCoverageRules = (
  surface: CoverageSurface,
  rules: ReadonlyArray<CoverageRule>,
): Array<Violation> => {
  const violations: Array<Violation> = [];
  for (const rule of rules) {
    const matcher = globToRegExp(rule.path);
    const matched = surface.paths.filter((path) => matcher.test(path));
    const eligible = surface.eligiblePaths.filter((path) => matcher.test(path));

    if (eligible.length === 0) {
      violations.push({
        severity: "structural",
        rule: "coverage-rule-unmatched",
        message:
          matched.length === 0
            ? `Coverage rule "${rule.path}" matches no page in the graph.`
            : `Coverage rule "${rule.path}" matches only pages that are not sitemap-eligible.`,
        fix: "Point the rule at a sitemap-eligible path, or drop it.",
      });
      continue;
    }

    for (const path of eligible) {
      const inbound = surface.inbound(path);
      if (inbound >= rule.minInbound) continue;
      violations.push({
        severity: "structural",
        rule: "inbound-link-coverage",
        path,
        message: `"${path}" has ${inbound} incoming contextual link(s); the coverage rule requires ${rule.minInbound}.`,
        fix: `Add ${rule.minInbound - inbound} contextual link(s) pointing at "${path}".`,
      });
    }
  }
  return violations;
};

/** The sitemap-eligible path set of a declared graph, in graph insertion order. */
const eligiblePathsOf = (graph: SeoGraph): ReadonlyArray<string> =>
  [...graph.nodes.values()].filter(isSitemapEligible).map((node) => node.path);

/**
 * Enforce contextual-link coverage against the *declared* graph: only `related`
 * edges count — breadcrumb ancestry is navigation, not context.
 */
export function checkCoverage(
  graph: SeoGraph,
  rules: ReadonlyArray<CoverageRule>,
): Array<Violation> {
  return checkCoverageRules(
    {
      paths: [...graph.nodes.keys()],
      eligiblePaths: eligiblePathsOf(graph),
      inbound: (path) =>
        graph.edges.filter((edge) => edge.type === "related" && edge.to === path).length,
    },
    rules,
  );
}

/**
 * Enforce contextual-link coverage against the *rendered* graph: only same-origin
 * body-region anchors count. Nav, header, and footer anchors are site chrome, so
 * a page linked solely from them has no contextual inbound link — the same
 * distinction the declared pass draws by counting `related` edges alone.
 *
 * The target universe is the declared graph's sitemap-eligible pages: the globs
 * in `seo.config.ts` are written against declared paths, and the crawl is what
 * supplies the served edges. Pass the crawl's `internalEdges` (each edge carries
 * its `region`).
 */
export function checkRenderedCoverage(
  graph: SeoGraph,
  renderedEdges: ReadonlyArray<LinkEdge>,
  rules: ReadonlyArray<CoverageRule>,
): Array<Violation> {
  const inbound = new Map<string, number>();
  for (const edge of renderedEdges) {
    if (edge.region !== "body") continue;
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }
  return checkCoverageRules(
    {
      paths: [...graph.nodes.keys()],
      eligiblePaths: eligiblePathsOf(graph),
      inbound: (path) => inbound.get(path) ?? 0,
    },
    rules,
  );
}

/** Structural violations fail `pagegraph check`; editorial-only stays green. */
export const hasStructuralViolations = (violations: ReadonlyArray<Violation>): boolean =>
  violations.some((violation) => violation.severity === "structural");
