import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  allowDirtyFlag,
  baseFlags,
  dryRunFlag,
  queryFlag,
  suggestionsFlag,
  workflowCommand,
} from "./research";

const writeFlags = { dryRun: dryRunFlag, allowDirty: allowDirtyFlag };
const allowPrivateFlag = Flag.Boolean("allow-private").pipe(
  Flag.withDescription("Allow localhost/private site probes for suggestion freshness (local development only)"),
  Flag.withDefault(false),
);

/** File-writing content, metadata, schema, and link workflows. */
export const improveCommandGroup = Command.make("improve").pipe(
  Command.withDescription("Apply page-backed SEO improvements through the configured OpenCode agent"),
  Command.withSubcommands([
    workflowCommand({
      name: "content",
      workflow: "improve.content",
      exampleArgs: "--page /pricing",
      description: "Edit page copy using research and persisted Jev state",
      flags: {
        ...baseFlags,
        query: queryFlag,
        dryRun: writeFlags.dryRun,
        allowDirty: writeFlags.allowDirty,
      },
      writesFiles: true,
    }),
    workflowCommand({
      name: "metadata",
      workflow: "improve.metadata",
      exampleArgs: "--page /pricing",
      description: "Edit titles, descriptions, and related head metadata",
      flags: {
        ...baseFlags,
        dryRun: writeFlags.dryRun,
        allowDirty: writeFlags.allowDirty,
      },
      writesFiles: true,
    }),
    workflowCommand({
      name: "schema",
      workflow: "improve.schema",
      exampleArgs: "--page /pricing",
      description: "Audit and generate justified JSON-LD for routes and documentation",
      flags: {
        ...baseFlags,
        dryRun: writeFlags.dryRun,
        allowDirty: writeFlags.allowDirty,
      },
      writesFiles: true,
    }),
    workflowCommand({
      name: "links",
      workflow: "improve.links",
      exampleArgs: "--page /docs/email",
      description: "Add contextual internal links and update PageGraph declarations when appropriate",
      flags: {
        ...baseFlags,
        suggestions: suggestionsFlag,
        allowPrivate: allowPrivateFlag,
        dryRun: writeFlags.dryRun,
        allowDirty: writeFlags.allowDirty,
      },
      writesFiles: true,
    }),
  ]),
);
