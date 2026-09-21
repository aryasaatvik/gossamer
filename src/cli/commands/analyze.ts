import * as Command from "effect/unstable/cli/Command";

import {
  queryFlag,
  researchFlags,
  serpFlags,
  workflowCommand,
} from "./research";

/** Page-backed content and search-result analysis workflows. */
export const analyzeCommandGroup = Command.make("analyze").pipe(
  Command.withDescription("Analyze search intent, content quality, and AI-search readiness"),
  Command.withSubcommands([
    workflowCommand({
      name: "serp",
      workflow: "analyze.serp",
      exampleArgs: '--query "transactional email api" --device desktop',
      description: "Compare page intent and format with current search results",
      flags: serpFlags,
    }),
    workflowCommand({
      name: "content",
      workflow: "analyze.content",
      exampleArgs: "--page /pricing",
      description: "Evaluate substance, intent ownership, differentiation, and answer quality",
      flags: { ...researchFlags, query: queryFlag },
    }),
    workflowCommand({
      name: "ai-search",
      workflow: "analyze.ai-search",
      exampleArgs: "--page /docs/email",
      description: "Evaluate extractability, entity clarity, citation support, and answer readiness",
      flags: researchFlags,
    }),
  ]),
);
