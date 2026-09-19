import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";

import { checkGraph, hasStructuralViolations } from "../../core/checks";
import { acquireGraph, loadSeoConfig } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";
import { renderViolations } from "../render";

export const checkCommand = Command.make("check", { json: jsonFlag }).pipe(
  Command.withDescription("Check the SEO graph; exit 1 on any structural violation"),
  Command.withExamples([
    { command: "gossamer check", description: "Run every rule and print the violations" },
    { command: "gossamer check --json", description: "Violations as JSON (exit 1 iff structural)" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ json }) {
      const config = yield* loadSeoConfig;
      const graph = yield* Effect.scoped(acquireGraph(config));
      const violations = checkGraph(graph);
      const structural = violations.filter((violation) => violation.severity === "structural");

      if (json) {
        yield* printJson({
          ok: structural.length === 0,
          structural: structural.length,
          editorial: violations.length - structural.length,
          violations,
        });
      } else {
        yield* printText(renderViolations(violations));
      }

      if (hasStructuralViolations(violations)) {
        return yield* new SeoCliError({
          message: `${structural.length} structural violation(s) — see the report above.`,
        });
      }
    }),
  ),
);
