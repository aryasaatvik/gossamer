import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { renderRobots } from "../../core/projections";
import { acquireGraph, loadSeoConfig } from "../load-config";
import { indexableFlag, originFlag, originOf, printText } from "../output";

export const robotsCommand = Command.make("robots", {
  origin: originFlag,
  indexable: indexableFlag,
}).pipe(
  Command.withDescription("Render robots.txt from the graph (the exact server-route output)"),
  Command.withExamples([
    { command: "gossamer robots", description: "The robots.txt, under the origin from seo.config.ts" },
    {
      command: "gossamer robots --origin https://preview.example.com --no-indexable",
      description: "Disallow-all with no Sitemap line — the preview posture",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ origin, indexable }) {
      const config = yield* loadSeoConfig;
      const graph = yield* Effect.scoped(acquireGraph(config));
      yield* printText(
        renderRobots(graph, {
          origin: originOf(origin, config.origin),
          indexable,
          disallow: config.disallow,
          contentSignal: config.contentSignal,
          directives: config.directives,
          transform: config.transform,
        }),
      );
    }),
  ),
);
