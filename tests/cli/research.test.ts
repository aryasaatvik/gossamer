import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

const run = (args: ReadonlyArray<string>) =>
  spawnSync("bun", [cli, "research", "keywords", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });

describe("pagegraph research keywords", () => {
  it("documents human and machine-readable invocations", () => {
    const result = run(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'pagegraph research keywords --query "transactional email api" --market us',
    );
    expect(result.stdout).toContain(
      'pagegraph research keywords --query "transactional email api" --market us --json',
    );
    expect(result.stdout).not.toContain("--input");
    expect(result.stdout).not.toContain("--no-input");
  });

  it.each(["--input", "--no-input"])("rejects obsolete %s interaction control", (flag) => {
    const result = run([flag]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Unrecognized flag: ${flag}`);
  });
});
