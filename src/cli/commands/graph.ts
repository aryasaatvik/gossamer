import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { acquireGraph, loadSeoConfig } from "../load-config";
import { printJson, printText } from "../output";
import { orphanPaths, renderMermaid, renderOrphans, renderTree } from "../render";
import { serializeGraph } from "../serialize";

const formatFlag = Flag.choice("format", ["tree", "mermaid", "json"]).pipe(
  Flag.withDescription("Output format: tree (default), mermaid diagram, or json"),
  Flag.withDefault("tree"),
);

const orphansFlag = Flag.boolean("orphans").pipe(
  Flag.withDescription("Show only orphan nodes (nothing links to them)"),
  Flag.withDefault(false),
);

export const graphCommand = Command.make("graph", {
  format: formatFlag,
  orphans: orphansFlag,
}).pipe(
  Command.withDescription("Render the SEO graph as a tree, a Mermaid diagram, or JSON"),
  Command.withExamples([
    { command: "gossamer graph", description: "The graph as an indented path tree" },
    { command: "gossamer graph --format mermaid", description: "A Mermaid diagram of nodes and edges" },
    { command: "gossamer graph --orphans", description: "Only nodes with no incoming edge" },
    { command: "gossamer graph --format json", description: "The serialized graph on stdout" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ format, orphans }) {
      const config = yield* loadSeoConfig;
      const graph = yield* Effect.scoped(acquireGraph(config));

      if (format === "json") {
        const serialized = serializeGraph(graph);
        if (!orphans) return yield* printJson(serialized);
        const orphanSet = orphanPaths(graph);
        return yield* printJson({
          nodes: serialized.nodes.filter((node) => orphanSet.has(node.path)),
          edges: serialized.edges.filter(
            (edge) => orphanSet.has(edge.from) && orphanSet.has(edge.to),
          ),
        });
      }

      if (format === "mermaid") return yield* printText(renderMermaid(graph, orphans));
      return yield* printText(orphans ? renderOrphans(graph) : renderTree(graph));
    }),
  ),
);
