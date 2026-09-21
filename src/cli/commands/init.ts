import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import presetAgents from "../preset/opencode/AGENTS.md" with { type: "text" };
import presetSeoAgent from "../preset/opencode/agents/seo.md" with { type: "text" };
import presetOpenCode from "../preset/opencode/opencode.jsonc" with { type: "text" };
import presetKeywordResearchExecutor from "../preset/opencode/skills/keyword-research/references/executor.md" with {
  type: "text",
};
import presetKeywordResearchSkill from "../preset/opencode/skills/keyword-research/SKILL.md" with { type: "text" };
import presetGitignore from "../preset/gitignore.txt" with { type: "text" };
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
  ".pagegraph/.gitignore": presetGitignore,
  ".pagegraph/opencode/opencode.jsonc": presetOpenCode,
  ".pagegraph/opencode/AGENTS.md": presetAgents,
  ".pagegraph/opencode/agents/seo.md": presetSeoAgent,
  ".pagegraph/opencode/skills/keyword-research/SKILL.md": presetKeywordResearchSkill,
  ".pagegraph/opencode/skills/keyword-research/references/executor.md":
    presetKeywordResearchExecutor,
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
    {
      command: "pagegraph init",
      description: "Create .pagegraph/opencode without overwriting files",
    },
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
