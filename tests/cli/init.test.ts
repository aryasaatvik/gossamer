import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));
const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const run = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync("bun", [cli, "init", ...args], { cwd, encoding: "utf8", timeout: 20_000 });

const dirtyGitRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "pagegraph-init-git-"));
  directories.push(root);
  writeFileSync(join(root, "tracked.txt"), "before\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PageGraph Test",
      "-c",
      "user.email=pagegraph@example.test",
      "commit",
      "--quiet",
      "-m",
      "init",
    ],
    { cwd: root },
  );
  writeFileSync(join(root, "tracked.txt"), "after\n");
  return root;
};

describe("pagegraph init", () => {
  it("previews and then creates a preset without overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "pagegraph-init-"));
    directories.push(root);
    const preview = run(root, ["--dry-run", "--json"]);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).created).toContain(".pagegraph/opencode/opencode.jsonc");
    expect(existsSync(join(root, ".pagegraph"))).toBe(false);

    expect(run(root, []).status).toBe(0);
    const config = join(root, ".pagegraph/opencode/opencode.jsonc");
    expect(readFileSync(config, "utf8")).toContain("Executor plugin");
    expect(readFileSync(join(root, ".pagegraph/opencode/agents/seo.md"), "utf8")).toContain(
      "Research is read-only",
    );
    expect(
      readFileSync(join(root, ".pagegraph/opencode/skills/keyword-research/SKILL.md"), "utf8"),
    ).toContain("Executor Starters");
    expect(run(root, []).stdout).toContain("Kept 26 existing file(s)");
  });

  it("refuses a dirty tree unless --allow-dirty is explicit", () => {
    const root = dirtyGitRepository();
    const refused = run(root, []);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("working tree is dirty");
    expect(existsSync(join(root, ".pagegraph"))).toBe(false);

    const allowed = run(root, ["--allow-dirty", "--json"]);
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout).created).toContain(
      ".pagegraph/opencode/skills/keyword-research/SKILL.md",
    );
  });

  it("allows a dirty-tree preview without writing files", () => {
    const root = dirtyGitRepository();
    const preview = run(root, ["--dry-run", "--json"]);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).dryRun).toBe(true);
    expect(existsSync(join(root, ".pagegraph"))).toBe(false);
  });

  it("co-locates dynamic, non-exhaustive Executor recipes with each skill", () => {
    const root = mkdtempSync(join(tmpdir(), "pagegraph-init-recipes-"));
    directories.push(root);
    expect(run(root, []).status).toBe(0);
    const skill = (name: string, file = "SKILL.md") =>
      readFileSync(join(root, `.pagegraph/opencode/skills/${name}/${file}`), "utf8");

    const names = [
      "keyword-research",
      "competitive-landscape",
      "authority-research",
      "serp-analysis",
      "content-analysis",
      "ai-search",
      "site-architecture",
      "content-improvement",
      "metadata-improvement",
      "schema",
      "internal-linking",
    ];
    for (const name of names) {
      expect(skill(name)).toContain("references/executor.md");
      const executor = skill(name, "references/executor.md");
      expect(executor).toContain("tools.executor.search");
      expect(executor).toContain("search({ query:");
      expect(executor).toContain("starting points");
    }
    expect(skill("keyword-research", "references/executor.md")).toContain("Google Search Console");
    expect(skill("site-architecture", "references/executor.md")).toContain("Bing Webmaster");
    expect(skill("authority-research", "references/executor.md")).toContain("backlink");
  });
});
