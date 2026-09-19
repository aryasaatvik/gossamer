import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

const SITEMAP = `{ priority: 0.5, changeFrequency: "monthly" }`;

const config = (edges: string, coverage: string): string => `const node = (path) => ({
  path,
  kind: "page",
  source: "route",
  policy: {
    kind: "page",
    sitemap: ${SITEMAP},
    link: { title: path, description: "A page with a card for related links." },
  },
});

export default {
  origin: "https://example.com",
  disallow: [],
  ${coverage}
  loadGraph: async () => ({
    graph: {
      nodes: new Map([
        ["/pricing", node("/pricing")],
        ["/about", node("/about")],
      ]),
      edges: ${edges},
    },
    dispose: async () => {},
  }),
};
`;

const temporaryDirectories: Array<string> = [];

const configDirectory = (contents: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "pagegraph-check-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "seo.config.mjs"), contents);
  return directory;
};

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (args: ReadonlyArray<string>, cwd: string): CliResult => {
  const result = spawnSync("bun", [cli, "check", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

interface Report {
  readonly ok: boolean;
  readonly structural: number;
  readonly editorial: number;
  readonly violations: ReadonlyArray<{ rule: string; path?: string; severity: string }>;
}

const COVERAGE_VIOLATED = `coverage: [{ path: "/pricing", minInbound: 1 }],`;
const COVERAGE_SATISFIED = `coverage: [{ path: "/pricing", minInbound: 1 }],`;
const RELATED = `[{ from: "/about", to: "/pricing", type: "related" }]`;

describe("pagegraph check — coverage rules", () => {
  it("fails with an inbound-link-coverage violation when the rule is unmet", () => {
    const directory = configDirectory(config("[]", COVERAGE_VIOLATED));
    const result = run(["--json"], directory);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.ok).toBe(false);
    expect(report.structural).toBe(1);
    const violation = report.violations.find((item) => item.rule === "inbound-link-coverage");
    expect(violation).toMatchObject({ severity: "structural", path: "/pricing" });
  });

  it("passes when every coverage rule is satisfied", () => {
    const directory = configDirectory(config(RELATED, COVERAGE_SATISFIED));
    const result = run(["--json"], directory);
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as Report).ok).toBe(true);
  });

  it("lets --require-inbound override the config policy", () => {
    const directory = configDirectory(config(RELATED, COVERAGE_SATISFIED));
    const result = run(["--require-inbound", "/pricing=2", "--json"], directory);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.violations.some((item) => item.rule === "inbound-link-coverage")).toBe(true);
  });

  it("enforces multiple repeatable flags independently", () => {
    const directory = configDirectory(config(RELATED, ""));
    const result = run(
      ["--require-inbound", "/pricing=1", "--require-inbound", "/about=1", "--json"],
      directory,
    );

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.violations.map((item) => item.path)).toEqual(["/about"]);
  });

  it("keeps existing structural checks working alongside coverage", () => {
    const edges = `[{ from: "/pricing", to: "/gone", type: "related" }]`;
    const directory = configDirectory(config(edges, COVERAGE_VIOLATED));
    const result = run(["--json"], directory);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as Report;
    const rules = report.violations.map((item) => item.rule);
    expect(rules).toContain("dead-edge");
    expect(rules).toContain("inbound-link-coverage");
  });

  it("rejects a flag without an equals sign", () => {
    const directory = configDirectory(config("[]", ""));
    const result = run(["--require-inbound", "pricing"], directory);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('must be "<path-glob>=<n>"');
  });

  it("rejects a non-positive flag count", () => {
    const directory = configDirectory(config("[]", ""));
    const result = run(["--require-inbound", "/pricing=0"], directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("positive integer");
  });
});
