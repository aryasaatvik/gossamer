import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { changedFiles, inspectGit } from "../../src/workflows/git";

const directories: Array<string> = [];
const git = (root: string, ...args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
};
const gitOutput = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workflow Git inspection", () => {
  it("normalizes repository paths relative to a nested project root", () => {
    const repo = mkdtempSync(join(tmpdir(), "pagegraph-git-"));
    directories.push(repo);
    const root = join(repo, "apps", "web");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "route.ts"), "export const route = 'before';\n");
    writeFileSync(join(repo, "outside.ts"), "export const shared = 'before';\n");
    git(repo, "init");
    git(repo, "config", "user.name", "PageGraph Test");
    git(repo, "config", "user.email", "pagegraph@example.com");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "test fixture");

    const before = inspectGit(root);
    writeFileSync(join(root, "src", "route.ts"), "export const route = 'after';\n");
    writeFileSync(join(repo, "outside.ts"), "export const shared = 'after';\n");
    writeFileSync(join(repo, "new-shared.ts"), "export const added = true;\n");

    const after = inspectGit(root);
    expect(before.dirty).toBe(false);
    expect(after.files).toEqual(["../../new-shared.ts", "../../outside.ts", "src/route.ts"]);
    expect(changedFiles(before, after)).toEqual(after.files);
  });

  it("fingerprints sibling submodules without hiding other tracked changes", () => {
    const repo = mkdtempSync(join(tmpdir(), "pagegraph-gitlink-"));
    directories.push(repo);
    const root = join(repo, "apps", "web");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "route.ts"), "export const route = 'before';\n");
    const submodule = join(repo, "vendor", "search");
    mkdirSync(submodule, { recursive: true });
    git(submodule, "init");
    git(submodule, "config", "user.name", "PageGraph Test");
    git(submodule, "config", "user.email", "pagegraph@example.com");
    writeFileSync(join(submodule, "README.md"), "search adapter\n");
    git(submodule, "add", "README.md");
    git(submodule, "commit", "-m", "submodule fixture");
    const submoduleHead = gitOutput(submodule, "rev-parse", "HEAD");

    git(repo, "init");
    git(repo, "config", "user.name", "PageGraph Test");
    git(repo, "config", "user.email", "pagegraph@example.com");
    git(repo, "config", "diff.ignoreSubmodules", "none");
    git(repo, "add", "apps/web/src/route.ts");
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${submoduleHead},vendor/search`);
    git(repo, "commit", "-m", "test fixture");

    const before = inspectGit(root);
    writeFileSync(join(root, "src", "route.ts"), "export const route = 'after';\n");
    writeFileSync(join(submodule, "README.md"), "updated adapter\n");
    git(submodule, "add", "README.md");
    git(submodule, "commit", "-m", "advance submodule");

    const after = inspectGit(root);
    expect(after.files).toEqual(["../../vendor/search", "src/route.ts"]);
    expect(changedFiles(before, after)).toEqual(after.files);

    writeFileSync(join(submodule, "README.md"), "first uncommitted edit\n");
    const dirtySubmodule = inspectGit(root);
    writeFileSync(join(submodule, "README.md"), "second uncommitted edit\n");
    expect(changedFiles(dirtySubmodule, inspectGit(root))).toEqual(["../../vendor/search"]);

    rmSync(join(root, "src", "route.ts"));
    mkdirSync(join(root, "src", "route.ts"));
    writeFileSync(join(root, "src", "route.ts", "nested.ts"), "export const invalid = true;\n");
    expect(() => inspectGit(root)).toThrow();
  });
});
