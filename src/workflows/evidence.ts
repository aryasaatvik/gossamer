import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SeoWorkflowContextConfig } from "../config";
import type { SeoGraph } from "../core/graph";
import { serializeGraph } from "../cli/serialize";
import type { WorkflowId, WorkflowTargetOptions } from "./model";

const matches = (value: string, pattern: string): boolean => {
  if (pattern === value) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
};

export const selectGraph = (graph: SeoGraph, options: WorkflowTargetOptions): SeoGraph => {
  const selected = [...graph.nodes.values()].filter(
    (node) =>
      (options.pages.length === 0 || options.pages.some((pattern) => matches(node.path, pattern))) &&
      (options.kinds.length === 0 || options.kinds.includes(node.kind)),
  );
  const paths = new Set(selected.slice(0, options.limit).map((node) => node.path));
  return {
    nodes: new Map(selected.slice(0, options.limit).map((node) => [node.path, node])),
    edges: graph.edges.filter((edge) => paths.has(edge.from) && paths.has(edge.to)),
    collisions: graph.collisions,
  };
};

export const collectContextFiles = (
  root: string,
  workflow: WorkflowId,
  context: SeoWorkflowContextConfig | undefined,
): ReadonlyArray<{ readonly path: string; readonly content: string }> => {
  const paths = [...(context?.files ?? []), ...(context?.byWorkflow?.[workflow] ?? [])];
  return [...new Set(paths)].map((path) => ({ path, content: readFileSync(resolve(root, path), "utf8") }));
};

export const collectWorkflowEvidence = (
  graph: SeoGraph,
  options: WorkflowTargetOptions,
  root: string,
  workflow: WorkflowId,
  context: SeoWorkflowContextConfig | undefined,
) => ({
  graph: serializeGraph(selectGraph(graph, options)),
  sources: collectContextFiles(root, workflow, context),
});
