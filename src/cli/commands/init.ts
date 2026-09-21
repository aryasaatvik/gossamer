import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { inspectGit } from "../../workflows/git";
import { printJson, printText, SeoCliError } from "../output";
import { jsonFlag } from "../output";

const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("List scaffold files without writing them"),
  Flag.withDefault(false),
);
const allowDirtyFlag = Flag.Boolean("allow-dirty").pipe(
  Flag.withDescription("Allow scaffolding when the Git working tree is already dirty"),
  Flag.withDefault(false),
);

const PRESET: Readonly<Record<string, string>> = {
  ".pagegraph/.gitignore": "runs/\n",
  ".pagegraph/opencode/opencode.jsonc": `{
  "default_agent": "seo",
  "plugins": [
    // Add your Executor plugin package or local path here.
    // "opencode-plugin-executor"
  ]
}
`,
  ".pagegraph/opencode/AGENTS.md": `# PageGraph SEO

Use the seo agent for PageGraph workflows. Preserve project instructions, cite repository and
provider evidence, and use Executor catalog search before choosing live SEO tools.
`,
  ".pagegraph/opencode/agents/seo.md": `---
description: Page-backed SEO research and improvement agent
mode: primary
---

Start from PageGraph's deterministic evidence. Route work through the content, technical, and
authority skills. Search Executor dynamically for current integrations and tools; recipes are
examples rather than an exhaustive catalog. Fail clearly when required live evidence is absent.
`,
  ".pagegraph/opencode/skills/content/SKILL.md": `---
name: content
description: Research keyword demand, SERPs, competitors, intent, content, metadata, and AI-search readiness.
---

# Content

Use PageGraph's page evidence as the baseline. Search Executor for current keyword, SERP, Search
Console, Bing, OpenSEO, or DataForSEO capabilities, then compose the best available tools. Example
pseudocode: search the catalog for keyword demand, execute matching tools for the requested market,
and retain the returned evidence. Discover better tools dynamically when available.
`,
  ".pagegraph/opencode/skills/technical/SKILL.md": `---
name: technical
description: Analyze routes, Fumadocs content, metadata, JSON-LD, architecture, and internal links.
---

# Technical

Reconcile PageGraph's route graph with source and rendered evidence. Use Executor search when live
crawl, indexing, or webmaster evidence is required. Keep every recommendation tied to a file, page,
graph edge, or provider result.
`,
  ".pagegraph/opencode/skills/authority/SKILL.md": `---
name: authority
description: Research and qualify legitimate directory, editorial, partner, and community opportunities.
---

# Authority

Search Executor for live authority and backlink evidence. Compose available tools rather than
assuming provider addresses. Reject spam and retain the evidence supporting every opportunity.
`,
};

const repositoryRoot = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
};

export const initCommand = Command.make("init", {
  dryRun: dryRunFlag,
  allowDirty: allowDirtyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Scaffold a user-owned PageGraph OpenCode SEO preset"),
  Command.withExamples([
    { command: "pagegraph init", description: "Create .pagegraph/opencode without overwriting files" },
    { command: "pagegraph init --dry-run --json", description: "Preview the scaffold as JSON" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ dryRun, allowDirty, json }) {
      const root = repositoryRoot();
      const git = inspectGit(root);
      if (!dryRun && git.dirty && !allowDirty) {
        return yield* new SeoCliError({
          message: "working tree is dirty; use --dry-run or --allow-dirty",
        });
      }
      const created: Array<string> = [];
      const existing: Array<string> = [];
      for (const [relative, contents] of Object.entries(PRESET)) {
        const file = resolve(root, relative);
        if (existsSync(file)) {
          existing.push(relative);
          continue;
        }
        created.push(relative);
        if (!dryRun) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, contents, { encoding: "utf8", flag: "wx" });
        }
      }
      const result = { root, dryRun, created, existing };
      if (json) yield* printJson(result);
      else {
        yield* printText(
          `${dryRun ? "Would create" : "Created"} ${created.length} file(s). Kept ${existing.length} existing file(s).`,
        );
      }
    }),
  ),
);
