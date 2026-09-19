import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { renderSitemap } from "../../core/projections";
import { acquireGraph, loadSeoConfig } from "../load-config";
import { indexableFlag, originFlag, originOf, printText } from "../output";

export const sitemapCommand = Command.make("sitemap", {
  origin: originFlag,
  indexable: indexableFlag,
}).pipe(
  Command.withDescription("Render sitemap.xml from the graph (the exact server-route output)"),
  Command.withExamples([
    {
      command: "pagegraph sitemap",
      description: "The sitemap XML, under the origin from seo.config.ts",
    },
    {
      command: "pagegraph sitemap --origin https://preview.example.com --no-indexable",
      description: "Sitemap body is host-independent; robots.txt is what gates crawling",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ origin, indexable }) {
      const config = yield* loadSeoConfig;
      const graph = yield* Effect.scoped(acquireGraph(config));
      yield* printText(
        renderSitemap(graph, { origin: originOf(origin, config.origin), indexable }),
      );
    }),
  ),
);
