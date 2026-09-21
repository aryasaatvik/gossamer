import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));
const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const run = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync("bun", [cli, "init", ...args], { cwd, encoding: "utf8", timeout: 20_000 });

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
    expect(run(root, []).stdout).toContain("Kept 7 existing file(s)");
  });
});
