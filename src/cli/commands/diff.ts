import { Effect, FileSystem, Schema } from "effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";

import {
  AuditComparisonResult,
  compareAuditReports,
} from "../../audit/diff";
import { AuditReport } from "../../audit/model";
import { renderAuditDiff } from "../../audit/render";
import { jsonFlag, printJson, printText, SeoCliError } from "../output";

const before = Argument.string("before.json").pipe(
  Argument.withDescription("Earlier gossamer audit JSON artifact"),
);
const after = Argument.string("after.json").pipe(
  Argument.withDescription("Later gossamer audit JSON artifact"),
);

const readAuditReport = Effect.fn("SeoCli.readAuditReport")(function* (
  label: "before" | "after",
  path: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      (error) =>
        new SeoCliError({
          message: `Could not read ${label} report ${path}: ${error.message}`,
        }),
    ),
  );
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AuditReport),
  )(contents).pipe(
    Effect.mapError(
      (error) =>
        new SeoCliError({
          message: `Invalid ${label} report ${path}: ${error.message}`,
        }),
    ),
  );
});

export const diffCommand = Command.make("diff", {
  before,
  after,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Compare two versioned gossamer audit JSON artifacts for semantic regressions",
  ),
  Command.withExamples([
    {
      command: "gossamer diff before.json after.json",
      description: "Render a human-readable semantic comparison",
    },
    {
      command: "gossamer diff before.json after.json --json",
      description: "Emit one versioned JSON diff on stdout",
    },
  ]),
  Command.withHandler(
    Effect.fn("SeoCli.diff")(function* (options) {
      const beforeReport = yield* readAuditReport("before", options.before);
      const afterReport = yield* readAuditReport("after", options.after);
      const comparison = compareAuditReports(beforeReport, afterReport);
      if (AuditComparisonResult.$is("InvalidReport")(comparison)) {
        return yield* new SeoCliError({
          message: `Invalid audit report invariants:\n${comparison.issues.map((issue) => `- ${issue}`).join("\n")}`,
        });
      }

      if (options.json) yield* printJson(comparison.diff);
      else yield* printText(renderAuditDiff(comparison.diff));

      if (comparison.diff.outcome === "regressed") {
        const summary = comparison.diff.summary;
        return yield* new SeoCliError({
          message: `${summary.structuralRegressions} structural, ${summary.scannerRegressions} scanner, and ${summary.coverageRegressions} coverage regression(s); see the diff above.`,
        });
      }
    }),
  ),
);
