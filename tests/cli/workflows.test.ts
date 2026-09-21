import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

const run = (args: ReadonlyArray<string>) =>
  spawnSync("bun", [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1" },
  });

describe("page-backed workflow command surface", () => {
  it.each([
    {
      group: "research",
      leaf: "keywords",
      example: '--query "transactional email api" --market us',
      flags: ["--query", "--market", "--language"],
    },
    {
      group: "research",
      leaf: "competitors",
      example: '--competitor resend.com',
      flags: ["--competitor"],
    },
    { group: "research", leaf: "authority", example: "--domain example.com", flags: ["--domain"] },
    {
      group: "analyze",
      leaf: "serp",
      example: '--query "transactional email api" --device desktop',
      flags: ["--query", "--device"],
    },
    { group: "analyze", leaf: "content", example: "--page /pricing", flags: ["--query"] },
    { group: "analyze", leaf: "ai-search", example: "--page /docs/email", flags: ["--page"] },
    { group: "plan", leaf: "architecture", example: "--page /templates", flags: ["--page"] },
    {
      group: "improve",
      leaf: "content",
      example: "--page /pricing",
      flags: ["--query", "--dry-run", "--allow-dirty"],
    },
    {
      group: "improve",
      leaf: "metadata",
      example: "--page /pricing",
      flags: ["--dry-run", "--allow-dirty"],
    },
    {
      group: "improve",
      leaf: "schema",
      example: "--page /pricing",
      flags: ["--dry-run", "--allow-dirty"],
    },
    {
      group: "improve",
      leaf: "links",
      example: "--page /docs/email",
      flags: ["--dry-run", "--allow-dirty"],
    },
  ] as const)("documents $group $leaf flags and examples", ({ group, leaf, example, flags }) => {
    const result = run([group, leaf, "--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`pagegraph ${group} ${leaf}`);
    expect(result.stdout).toContain("EXAMPLES");
    expect(result.stdout).toContain(example);
    expect(result.stdout).toContain("--json");
    expect(result.stdout).not.toContain("--input");
    expect(result.stdout).not.toContain("--no-input");
    for (const flag of flags) expect(result.stdout).toContain(flag);
  });

  it.each(["--input", "--no-input"])("rejects obsolete %s interaction control", (flag) => {
    const result = run(["analyze", "serp", flag]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Unrecognized flag: ${flag}`);
  });

  it("rejects unsupported SERP devices at the parser boundary", () => {
    const rejected = run(["analyze", "serp", "--device", "tablet"]);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("--device");
  });

  it("keeps mutation-only flags off read-only workflows", () => {
    const result = run(["research", "keywords", "--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unrecognized flag: --dry-run");
  });
});
