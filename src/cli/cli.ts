import * as Command from "effect/unstable/cli/Command";

import { checkCommand } from "./commands/check";
import { auditCommand } from "./commands/audit";
import { diffCommand } from "./commands/diff";
import { graphCommand } from "./commands/graph";
import { inspectCommand } from "./commands/inspect";
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
    "Inspect and audit a TanStack Start SEO graph: sitemap, robots, cross-links, structured data, and link decisions.",
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
  ]),
  Command.withSubcommands([
    auditCommand,
    diffCommand,
    graphCommand,
    inspectCommand,
    checkCommand,
    sitemapCommand,
    robotsCommand,
  ]),
);
