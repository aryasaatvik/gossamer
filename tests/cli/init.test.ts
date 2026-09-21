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
    ["-c", "user.name=PageGraph Test", "-c", "user.email=pagegraph@example.test", "commit", "--quiet", "-m", "init"],
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
    expect(run(root, []).stdout).toContain("Kept 6 existing file(s)");
  });

  it("refuses a dirty tree unless --allow-dirty is explicit", () => {
    const root = dirtyGitRepository();
    const refused = run(root, []);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("working tree is dirty");
    expect(existsSync(join(root, ".pagegraph"))).toBe(false);

    const allowed = run(root, ["--allow-dirty", "--json"]);
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout).created).toContain(".pagegraph/opencode/skills/content/SKILL.md");
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
    const skill = (name: string) => readFileSync(join(root, `.pagegraph/opencode/skills/${name}/SKILL.md`), "utf8");

    for (const name of ["content", "technical", "authority"]) {
      const contents = skill(name);
      expect(contents).toContain("tools.executor.search");
      expect(contents).toContain("search({ query:");
      expect(contents).toContain("non-exhaustive");
    }
    expect(skill("content")).toContain("Google Search Console");
    expect(skill("technical")).toContain("Bing Webmaster");
    expect(skill("authority")).toContain("backlink");
  });
});
