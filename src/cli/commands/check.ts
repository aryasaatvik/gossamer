import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { checkGraph, hasStructuralViolations, type CoverageRule } from "../../core/checks";
import { acquireGraph, loadSeoConfig } from "../load-config";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";
import { renderViolations } from "../render";

const requireInboundFlag = Flag.String("require-inbound").pipe(
  Flag.withDescription(
    'Require at least N incoming contextual links for a path glob: "<glob>=<n>" (repeatable)',
  ),
  Flag.between(0, 128),
);

/** Parse one `"<path-glob>=<n>"` coverage rule; both halves are user input. */
const parseCoverageRule = (value: string): Effect.Effect<CoverageRule, SeoCliError> => {
  const separator = value.lastIndexOf("=");
  if (separator <= 0) {
    return Effect.fail(
      new SeoCliError({ message: `--require-inbound must be "<path-glob>=<n>", received "${value}"` }),
    );
  }
  const path = value.slice(0, separator).trim();
  const count = Number(value.slice(separator + 1).trim());
  if (path === "") {
    return Effect.fail(
      new SeoCliError({ message: `--require-inbound must name a path glob, received "${value}"` }),
    );
  }
  if (!Number.isSafeInteger(count) || count <= 0) {
    return Effect.fail(
      new SeoCliError({
        message: `--require-inbound count must be a positive integer, received "${value}"`,
      }),
    );
  }
  return Effect.succeed({ path, minInbound: count });
};

export const checkCommand = Command.make("check", {
  json: jsonFlag,
  requireInbound: requireInboundFlag,
}).pipe(
  Command.withDescription("Check the SEO graph; exit 1 on any structural violation"),
  Command.withExamples([
    { command: "pagegraph check", description: "Run every rule and print the violations" },
    { command: "pagegraph check --json", description: "Violations as JSON (exit 1 iff structural)" },
    {
      command: 'pagegraph check --require-inbound "/pricing=2"',
      description: "Also require 2 contextual links into /pricing",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ json, requireInbound }) {
      const config = yield* loadSeoConfig;
      const flagRules = yield* Effect.forEach(requireInbound, parseCoverageRule);
      // Flags are a per-invocation override, mirroring `--origin`: when any are
      // given they replace the config's durable policy rather than merging.
      const coverage = flagRules.length > 0 ? flagRules : (config.coverage ?? []);
      const graph = yield* Effect.scoped(acquireGraph(config));
      const violations = checkGraph(graph, { coverage });
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
