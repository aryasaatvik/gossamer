import * as Command from "effect/unstable/cli/Command";

import { checkCommand } from "./commands/check";
import { auditCommand } from "./commands/audit";
import { analyzeCommandGroup } from "./commands/analyze";
import { diffCommand } from "./commands/diff";
import { graphCommand } from "./commands/graph";
import { inspectCommand } from "./commands/inspect";
import { initCommand } from "./commands/init";
import { linksCommand } from "./commands/links";
import { improveCommandGroup } from "./commands/improve";
import { planCommandGroup } from "./commands/plan";
import { researchCommandGroup } from "./commands/research";
import { robotsCommand } from "./commands/robots";
import { sitemapCommand } from "./commands/sitemap";

/**
 * Root `pagegraph` command. Every subcommand reads the same SEO graph that render
 * time, the sitemap/robots server routes, and the test suite read — the one the
 * app's `seo.config.ts` loader produces. Route declarations are the single
 * source of truth, and these are pure views over them.
 */
export const cli = Command.make("pagegraph").pipe(
  Command.withDescription(
    "Inspect, audit, research, and improve a TanStack Start site's page-backed SEO graph.",
  ),
  Command.withExamples([
    {
      command: "pagegraph audit https://example.com",
      description: "Audit any deployed website",
    },
    {
      command: "pagegraph check",
      description: "Fail (exit 1) on any structural SEO violation",
    },
    { command: "pagegraph graph", description: "Print the SEO graph as a tree" },
    { command: "pagegraph sitemap", description: "Render sitemap.xml" },
    {
      command: "pagegraph research keywords --query \"transactional email api\" --market us",
      description: "Run bounded page-backed keyword research",
    },
  ]),
  Command.withSubcommands([
    auditCommand,
    analyzeCommandGroup,
    initCommand,
    diffCommand,
    graphCommand,
    improveCommandGroup,
    inspectCommand,
    linksCommand,
    planCommandGroup,
    researchCommandGroup,
    checkCommand,
    sitemapCommand,
    robotsCommand,
  ]),
);
