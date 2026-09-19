import * as Effect from "effect/Effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { hasBlockingIssues } from "../../core/inspect-html";
import { inspectNode } from "../../core/projections";
import { fetchAndInspect } from "../live-inspect";
import { acquireGraph, loadSeoConfig } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";
import { renderLiveReport, renderNodeReport } from "../render";
import { serializeNode } from "../serialize";

const targetArg = Argument.string("target").pipe(
  Argument.withDescription("A route path (e.g. /pricing), or a full URL with --live"),
);

const liveFlag = Flag.boolean("live").pipe(
  Flag.withDescription("Fetch the URL and inspect its rendered <head> and JSON-LD"),
  Flag.withDefault(false),
);

export const inspectCommand = Command.make("inspect", {
  target: targetArg,
  live: liveFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Inspect one page: its graph declaration, or its live <head> with --live",
  ),
  Command.withExamples([
    {
      command: "pagegraph inspect /pricing",
      description: "The graph node, policy, and edges for a path",
    },
    {
      command: "pagegraph inspect https://example.com/pricing --live",
      description: "Fetch the page and validate its head tags + JSON-LD",
    },
    { command: "pagegraph inspect /blog/some-post --json", description: "The node report as JSON" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ target, live, json }) {
      if (live) {
        const report = yield* fetchAndInspect(target);
        if (json) yield* printJson(report);
        else yield* printText(renderLiveReport(report));
        if (hasBlockingIssues(report)) {
          return yield* new SeoCliError({
            message: `${report.issues.length} issue(s) found at ${target}.`,
          });
        }
        return;
      }

      const config = yield* loadSeoConfig;
      const graph = yield* Effect.scoped(acquireGraph(config));
      const report = inspectNode(graph, target);
      if (report === undefined) {
        return yield* new SeoCliError({
          message: `No node at "${target}". Run \`pagegraph graph\` to list paths, or pass a URL with --live.`,
        });
      }
      if (json) {
        return yield* printJson({
          node: serializeNode(report.node),
          inSitemap: report.inSitemap,
          incoming: report.incoming,
          outgoing: report.outgoing,
        });
      }
      return yield* printText(renderNodeReport(report));
    }),
  ),
);
