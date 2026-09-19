/**
 * Human-plane formatters for the `pagegraph` CLI. Every function here is pure and
 * returns a plain string (no ANSI, no I/O) — commands print it to stdout via
 * `printText`, and the machine plane (`--json` / `--format json`) bypasses this
 * module entirely. Keeping it string-in/string-out makes the formatting unit-
 * testable and keeps color/TTY concerns out of the command handlers.
 */

import type { Violation } from "../core/checks";
import type { SeoGraph, SeoNode } from "../core/graph";
import type { LiveHeadReport } from "../core/inspect-html";
import type { LinkCandidatePair, LinkClusterSummary } from "../core/link-candidates";
import type { SimpleEdge } from "../core/links";
import type { NodeReport } from "../core/projections";
import type { LinkDecisionRecord, LinksDecideReport, LinkVerdict } from "../links/decide";

/** Count of edges pointing *at* each node — 0 means nothing links to it. */
const incomingCounts = (graph: SeoGraph): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const node of graph.nodes.keys()) counts.set(node, 0);
  for (const edge of graph.edges) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  return counts;
};

/** Paths nothing links to (zero incoming edges) — the "orphan" set. */
export const orphanPaths = (graph: SeoGraph): Set<string> => {
  const incoming = incomingCounts(graph);
  return new Set([...graph.nodes.keys()].filter((path) => (incoming.get(path) ?? 0) === 0));
};

const byPath = (a: SeoNode, b: SeoNode): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A compact one-line summary of a node's policy — kind and the flags that matter. */
const nodeMarkers = (node: SeoNode): string => {
  const markers: Array<string> = [node.kind];
  if (node.source !== "route") markers.push(node.source);
  const sitemap = node.policy.sitemap;
  if (sitemap) markers.push(`sitemap:${sitemap.priority.toFixed(1)}`);
  if (node.policy.robots?.includes("noindex")) markers.push("noindex");
  if (node.policy.redirectTo) markers.push(`→ ${node.policy.redirectTo}`);
  return markers.join("  ");
};

/** Map each node to its parent = the longest strict path-prefix that is also a node. */
const parentOf = (path: string, nodePaths: Set<string>): string | undefined => {
  if (path === "/") return undefined;
  const segments = path.split("/").filter(Boolean);
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const candidate = `/${segments.slice(0, depth).join("/")}`;
    if (nodePaths.has(candidate)) return candidate;
  }
  return nodePaths.has("/") ? "/" : undefined;
};

/** Render the graph as an indented path hierarchy with per-node markers. */
export const renderTree = (graph: SeoGraph): string => {
  const nodePaths = new Set(graph.nodes.keys());
  const children = new Map<string, Array<string>>();
  const roots: Array<string> = [];
  for (const path of [...nodePaths].sort()) {
    const parent = parentOf(path, nodePaths);
    if (parent === undefined) roots.push(path);
    else {
      const bucket = children.get(parent);
      if (bucket) bucket.push(path);
      else children.set(parent, [path]);
    }
  }

  const lines: Array<string> = [];
  const walk = (path: string, depth: number): void => {
    const node = graph.nodes.get(path)!;
    lines.push(`${"  ".repeat(depth)}${path}  ·  ${nodeMarkers(node)}`);
    for (const child of children.get(path) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);

  return `${lines.join("\n")}\n\n${renderSummary(graph)}`;
};

/** One-line-per-node list of nodes nothing links to (no incoming graph edges). */
export const renderOrphans = (graph: SeoGraph): string => {
  const orphans = orphanPaths(graph);
  const orphanNodes = [...graph.nodes.values()]
    .filter((node) => orphans.has(node.path))
    .sort(byPath);
  if (orphanNodes.length === 0) return "No orphan nodes — every node has an incoming edge.";
  const lines = orphanNodes.map((node) => `${node.path}  ·  ${nodeMarkers(node)}`);
  return [
    `Orphans — ${orphanNodes.length} node(s) with no incoming edge (reachable only via nav/sitemap):`,
    "",
    ...lines,
  ].join("\n");
};

const sanitizeId = (path: string): string => `n_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;

/** Render the graph (or just its orphans) as a Mermaid `graph LR` diagram. */
export const renderMermaid = (graph: SeoGraph, orphansOnly: boolean): string => {
  const orphans = orphanPaths(graph);
  const nodes = [...graph.nodes.values()]
    .filter((node) => !orphansOnly || orphans.has(node.path))
    .sort(byPath);
  const visible = new Set(nodes.map((node) => node.path));

  const lines: Array<string> = ["graph LR"];
  for (const node of nodes) {
    lines.push(`  ${sanitizeId(node.path)}["${node.path}"]`);
  }
  if (!orphansOnly) {
    for (const edge of graph.edges) {
      if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
      lines.push(`  ${sanitizeId(edge.from)} -->|${edge.type}| ${sanitizeId(edge.to)}`);
    }
  }
  return lines.join("\n");
};

const renderSummary = (graph: SeoGraph): string => {
  const bySource = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    bySource.set(node.source, (bySource.get(node.source) ?? 0) + 1);
  }
  const byEdge = new Map<string, number>();
  for (const edge of graph.edges) byEdge.set(edge.type, (byEdge.get(edge.type) ?? 0) + 1);
  const sources = [...bySource.entries()].map(([source, count]) => `${source} ${count}`).join(", ");
  const edges = [...byEdge.entries()].map(([type, count]) => `${type} ${count}`).join(", ");
  return `${graph.nodes.size} nodes (${sources}) · ${graph.edges.length} edges (${edges})`;
};

/** Static `inspect <path>` report: the node's declaration, sitemap status, edges. */
export const renderNodeReport = (report: NodeReport): string => {
  const { node } = report;
  const lines: Array<string> = [
    node.path,
    `  kind        ${node.kind}`,
    `  source      ${node.source}`,
    `  in sitemap  ${report.inSitemap ? "yes" : "no"}`,
  ];
  if (node.policy.robots) lines.push(`  robots      ${node.policy.robots}`);
  if (node.policy.redirectTo) lines.push(`  redirect →  ${node.policy.redirectTo}`);
  if (node.policy.link) {
    lines.push(`  link.title  ${node.policy.link.title}`);
    lines.push(`  link.desc   ${node.policy.link.description}`);
  }
  if (node.instance) {
    lines.push(`  title       ${node.instance.title}`);
    if (node.instance.description) lines.push(`  description  ${node.instance.description}`);
    if (node.instance.publishedAt) lines.push(`  published   ${node.instance.publishedAt}`);
    if (node.instance.modifiedAt) lines.push(`  modified    ${node.instance.modifiedAt}`);
  }
  const edgeLine = (label: string, edges: NodeReport["outgoing"]): void => {
    if (edges.length === 0) return;
    lines.push(`  ${label}`);
    for (const edge of edges) {
      const other = label === "outgoing" ? edge.to : edge.from;
      lines.push(`    ${edge.type.padEnd(13)} ${other}`);
    }
  };
  edgeLine("outgoing", report.outgoing);
  edgeLine("incoming", report.incoming);
  return lines.join("\n");
};

/** Live `inspect <url> --live` report: fetched head tags + JSON-LD validation. */
export const renderLiveReport = (report: LiveHeadReport): string => {
  const lines: Array<string> = [
    `${report.url}  (HTTP ${report.status})`,
    `  title        ${report.title ?? "—"}`,
    `  description  ${report.description ?? "—"}`,
    `  canonical    ${report.canonical ?? "—"}`,
    `  robots       ${report.robots ?? "—"}`,
  ];
  const kv = (label: string, map: Record<string, string>): void => {
    const keys = Object.keys(map);
    if (keys.length === 0) return;
    lines.push(`  ${label}`);
    for (const key of keys) lines.push(`    ${key.padEnd(18)} ${map[key]}`);
  };
  kv("open graph", report.og);
  kv("twitter", report.twitter);
  if (report.jsonLd.length > 0) {
    lines.push("  json-ld");
    for (const block of report.jsonLd) {
      lines.push(`    ${block.valid ? "✓" : "✗"} ${block.type}`);
      for (const error of block.errors) lines.push(`        ${error}`);
    }
  }
  if (report.issues.length > 0) {
    lines.push("", `  ${report.issues.length} issue(s):`);
    for (const issue of report.issues) lines.push(`    ✗ ${issue}`);
  } else {
    lines.push("", "  ✓ required tags present, JSON-LD valid");
  }
  return lines.join("\n");
};

/** `pagegraph check` report: violations grouped by severity, with a headline count. */
export const renderViolations = (violations: ReadonlyArray<Violation>): string => {
  const structural = violations.filter((violation) => violation.severity === "structural");
  const editorial = violations.filter((violation) => violation.severity === "editorial");

  if (violations.length === 0) return "✓ No violations. The SEO graph is clean.";

  const block = (title: string, group: ReadonlyArray<Violation>): Array<string> => {
    if (group.length === 0) return [];
    const lines = [`${title} (${group.length}):`, ""];
    for (const violation of group) {
      const where = violation.path ? `  ${violation.path}` : "";
      lines.push(`  ✗ [${violation.rule}]${where}`);
      lines.push(`      ${violation.message}`);
      if (violation.fix) lines.push(`      fix: ${violation.fix}`);
    }
    lines.push("");
    return lines;
  };

  const parts: Array<string> = [
    ...block("Structural", structural),
    ...block("Editorial", editorial),
    structural.length > 0
      ? `${structural.length} structural, ${editorial.length} editorial — structural violations fail the check.`
      : `${editorial.length} editorial warning(s) — no structural violations.`,
  ];
  return parts.join("\n");
};

/** One page the crawl could not fetch. */
export interface LinksCrawlFailure {
  readonly url: string;
  readonly error: string;
}

/**
 * `pagegraph links verify` report: what a crawler actually receives, computed
 * from the served HTML, plus the gap against the declared graph when the app
 * has a `seo.config.ts`. This is the same object `--json` emits.
 */
export interface LinksVerifyReport {
  readonly kind: "links-verify";
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly seed: string;
  readonly crawl: {
    readonly pages: number;
    readonly limit: number;
    readonly truncated: boolean;
    readonly failures: ReadonlyArray<LinksCrawlFailure>;
    /** True when at least one captured body was cut at `--max-body-bytes`. */
    readonly bodyTruncated: boolean;
    /** URLs whose captured body was cut; anchors past the cutoff are missing. */
    readonly truncatedPages: ReadonlyArray<string>;
  };
  readonly rendered: {
    readonly pages: number;
    readonly internalEdges: number;
    readonly contextualEdges: number;
    readonly maxDepth: number | null;
    readonly orphans: ReadonlyArray<string>;
  };
  readonly declared: {
    readonly edges: number;
    readonly contextualEdges: number;
    readonly declaredNotRendered: ReadonlyArray<SimpleEdge>;
    readonly renderedNotDeclared: ReadonlyArray<SimpleEdge>;
  } | null;
  /** Non-fatal notes: body truncation, an unusable config, or an origin mismatch. */
  readonly warnings: ReadonlyArray<string>;
}

const edgeLine = (edge: SimpleEdge): string => `    ${edge.from} → ${edge.to}`;

/** Human `links verify` report: depth, orphans, and the declared-vs-rendered gap. */
export const renderLinksReport = (report: LinksVerifyReport): string => {
  const { crawl, rendered } = report;
  const coverage = `${crawl.pages} page(s) crawled${
    crawl.truncated ? ` of ${crawl.limit}, truncated` : ""
  }`;
  const lines: Array<string> = [
    `${report.seed}  (${coverage})`,
    "",
    `  max homepage depth  ${rendered.maxDepth ?? "—"}`,
    `  rendered orphans    ${rendered.orphans.length}`,
    `  internal edges      ${rendered.internalEdges}`,
    `  contextual edges    ${rendered.contextualEdges}`,
  ];

  if (rendered.orphans.length > 0) {
    lines.push("", "Orphans (no incoming internal edge):");
    for (const path of rendered.orphans) lines.push(`  ${path}`);
  }

  if (report.declared === null) {
    if (report.warnings.length === 0) {
      lines.push("", "No seo.config.ts declared graph — rendered-only report.");
    }
  } else {
    lines.push(
      "",
      `Declared vs rendered (${report.declared.edges} declared related edge(s)):`,
      `  declared not rendered  ${report.declared.declaredNotRendered.length}`,
    );
    for (const edge of report.declared.declaredNotRendered) lines.push(edgeLine(edge));
    lines.push(`  rendered not declared  ${report.declared.renderedNotDeclared.length}`);
    for (const edge of report.declared.renderedNotDeclared) lines.push(edgeLine(edge));
  }

  if (crawl.failures.length > 0) {
    lines.push("", `${crawl.failures.length} page(s) could not be fetched:`);
    for (const failure of crawl.failures) lines.push(`  ${failure.url}  ${failure.error}`);
  }

  if (report.warnings.length > 0) {
    lines.push("", `${report.warnings.length} warning(s):`);
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
};

const VERDICT_LABELS: Readonly<Record<LinkVerdict, string>> = {
  recommend: "Recommend",
  present: "Present",
  skip: "Skip",
  review: "Review",
};

const decisionLine = (record: LinkDecisionRecord): Array<string> => [
  `  ${record.sourceUrl} → ${record.destinationUrl}`,
  `    realReason ${record.realReason.toFixed(2)} · anchorPresent ${record.anchorPresent.toFixed(2)}`,
  `    "${record.sourceText}"`,
];

const verdictBlock = (verdict: LinkVerdict, records: ReadonlyArray<LinkDecisionRecord>): Array<string> => {
  if (records.length === 0) return [];
  const lines: Array<string> = [`${VERDICT_LABELS[verdict]} (${records.length}):`, ""];
  for (const record of records) lines.push(...decisionLine(record), "");
  return lines;
};

/**
 * Human `links decide` report: what the model answered and which candidates a
 * human still has to settle. The machine plane (`--json`) is
 * {@link LinksDecideReport} untouched.
 */
export const renderLinksDecideReport = (report: LinksDecideReport): string => {
  const { counts } = report;
  const lines: Array<string> = [
    `${counts.candidates} candidate(s) · model ${report.model} · threshold ${report.threshold.toFixed(2)}`,
    "",
    `  recommend  ${counts.recommend}`,
    `  present    ${counts.present}`,
    `  skip       ${counts.skip}`,
    `  review     ${counts.review}`,
    "",
  ];

  lines.push(...verdictBlock("recommend", report.resolved.filter((r) => r.verdict === "recommend")));
  lines.push(...verdictBlock("present", report.resolved.filter((r) => r.verdict === "present")));
  lines.push(...verdictBlock("skip", report.resolved.filter((r) => r.verdict === "skip")));

  if (report.review.length === 0) {
    lines.push("No candidates need review.");
  } else {
    lines.push(...verdictBlock("review", report.review));
  }

  return lines.join("\n").trimEnd();
};

/**
 * `pagegraph links candidates` report: a reviewable proposal of contextual
 * pairs, grouped by cluster, optionally carrying Jev's decisions. Nothing here
 * is applied — the plan is the end product. This is the same object `--json`
 * emits.
 */
export interface LinksCandidatesReport {
  readonly kind: "links-candidates";
  readonly schemaVersion: 1;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly clusters: ReadonlyArray<LinkClusterSummary>;
  readonly candidates: ReadonlyArray<LinkCandidatePair>;
  /** True when already-rendered anchors were supplied and excluded. */
  readonly rendered: boolean;
  readonly decisions: LinksDecideReport | null;
}

/** Human `links candidates` report: cluster counts, then each proposed pair. */
export const renderLinksCandidatesReport = (report: LinksCandidatesReport): string => {
  const lines: Array<string> = [
    `${report.total} candidate pair(s) · limit ${report.limit}${
      report.truncated ? ", truncated" : ""
    }`,
    report.rendered
      ? "Already-rendered anchors were excluded."
      : "No rendered data supplied; only declared edges were excluded.",
    "",
  ];

  if (report.clusters.length > 0) {
    lines.push("Clusters:", "");
    for (const cluster of report.clusters) {
      lines.push(`  ${cluster.key.padEnd(20)} ${cluster.candidates}`);
    }
    lines.push("");
  }

  if (report.candidates.length === 0) {
    lines.push("No contextual-link candidates — every plausible pair is already connected.");
    return lines.join("\n");
  }

  lines.push("Candidates:", "");
  for (const candidate of report.candidates) {
    lines.push(`  ${candidate.source} → ${candidate.destination}`);
    lines.push(`      ${candidate.reason}`);
  }

  if (report.decisions !== null) {
    lines.push("", "Jev decisions:", "", renderLinksDecideReport(report.decisions));
  }

  return lines.join("\n");
};
