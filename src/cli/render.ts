/**
 * Human-plane formatters for the `gossamer` CLI. Every function here is pure and
 * returns a plain string (no ANSI, no I/O) — commands print it to stdout via
 * `printText`, and the machine plane (`--json` / `--format json`) bypasses this
 * module entirely. Keeping it string-in/string-out makes the formatting unit-
 * testable and keeps color/TTY concerns out of the command handlers.
 */

import type { Violation } from "../core/checks";
import type { SeoGraph, SeoNode } from "../core/graph";
import type { LiveHeadReport } from "../core/inspect-html";
import type { NodeReport } from "../core/projections";

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

/** `gossamer check` report: violations grouped by severity, with a headline count. */
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
