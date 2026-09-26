import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));
const run = (...args: ReadonlyArray<string>) =>
  spawnSync("bun", [cli, "skills", ...args], { encoding: "utf8", timeout: 20_000 });

describe("pagegraph skills", () => {
  it("lists and serves the embedded skill without a project config", () => {
    const listed = run("list", "--json");
    expect(listed.status).toBe(0);
    expect(listed.stderr).toBe("");
    expect(JSON.parse(listed.stdout)).toEqual({ schemaVersion: 1, skills: ["core"] });

    const fetched = run("get", "core", "--json");
    expect(fetched.status).toBe(0);
    expect(fetched.stderr).toBe("");
    const skill = JSON.parse(fetched.stdout);
    expect(skill.schemaVersion).toBe(1);
    expect(skill.name).toBe("core");
    expect(skill.content).toContain("# Pagegraph and TanStack Start");
    expect(skill.content).toContain("pagegraph check");
  });

  it("reports unknown skill names with a discovery command", () => {
    const result = run("get", "missing");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown skill");
    expect(result.stderr).toContain("pagegraph skills list");
  });
});
