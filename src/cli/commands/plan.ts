import * as Command from "effect/unstable/cli/Command";

import { baseFlags, workflowCommand } from "./research";

/** Page-backed planning workflows. */
export const planCommandGroup = Command.make("plan").pipe(
  Command.withDescription("Plan page ownership, hierarchy, and internal-link improvements"),
  Command.withSubcommands([
    workflowCommand({
      name: "architecture",
      workflow: "plan.architecture",
      exampleArgs: "--page /templates",
      description: "Produce page ownership, hierarchy, and internal-link recommendations",
      flags: baseFlags,
    }),
  ]),
);
