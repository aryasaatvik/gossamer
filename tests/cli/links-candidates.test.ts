import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url));

const SITEMAP = `{ priority: 0.5, changeFrequency: "monthly" }`;

const CONFIG = `const node = (path, kind, source = "route") => ({
  path,
  kind,
  source,
  policy: { kind, sitemap: ${SITEMAP} },
});

export default {
  origin: "https://example.com",
  disallow: [],
  loadGraph: async () => ({
    graph: {
      nodes: new Map([
        ["/blog/a", node("/blog/a", "article", "blog")],
        ["/blog/b", node("/blog/b", "article", "blog")],
        ["/blog/c", node("/blog/c", "article", "blog")],
        ["/pricing", node("/pricing", "page")],
        ["/about", node("/about", "page")],
      ]),
      edges: [{ from: "/blog/a", to: "/blog/b", type: "related" }],
    },
    dispose: async () => {},
  }),
};
`;

const temporaryDirectories: Array<string> = [];

const configDirectory = (config: string): string => {
  const directory = mkdtempSync(join(tmpdir(), "pagegraph-candidates-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "seo.config.mjs"), config);
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
  const result = spawnSync("bun", [cli, "links", "candidates", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

interface Candidate {
  readonly source: string;
  readonly destination: string;
  readonly cluster: string;
  readonly reason: string;
}

interface Report {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly clusters: ReadonlyArray<{ key: string; candidates: number }>;
  readonly candidates: ReadonlyArray<Candidate>;
  readonly rendered: boolean;
}

describe("pagegraph links candidates", () => {
  it("emits a versioned reviewable plan of clustered pairs", () => {
    const directory = configDirectory(CONFIG);
    const result = run(["--json"], directory);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as Report;
    expect(report.kind).toBe("links-candidates");
    expect(report.schemaVersion).toBe(1);
    expect(report.total).toBe(6);
    expect(report.truncated).toBe(false);
    expect(report.rendered).toBe(false);
    expect(report.clusters).toEqual([
      { key: "blog", candidates: 4 },
      { key: "kind:page", candidates: 2 },
    ]);
    expect(report.candidates[0]).toEqual({
      source: "/blog/a",
      destination: "/blog/c",
      cluster: "blog",
      reason: 'same top-level section "/blog"',
    });
    // The declared /blog/a → /blog/b pair is excluded in both directions.
    expect(report.candidates.map((c) => `${c.source}→${c.destination}`)).toEqual([
      "/blog/a→/blog/c",
      "/blog/b→/blog/c",
      "/blog/c→/blog/a",
      "/blog/c→/blog/b",
      "/about→/pricing",
      "/pricing→/about",
    ]);
  });

  it("bounds output with --limit and flags truncation", () => {
    const directory = configDirectory(CONFIG);
    const result = run(["--limit", "2", "--json"], directory);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.candidates).toHaveLength(2);
    expect(report.total).toBe(6);
    expect(report.truncated).toBe(true);
    expect(report.limit).toBe(2);
  });

  it("restricts to a section cluster or a bare kind", () => {
    const directory = configDirectory(CONFIG);
    const bySection = JSON.parse(run(["--cluster", "blog", "--json"], directory).stdout) as Report;
    expect(bySection.total).toBe(4);
    expect(bySection.clusters).toEqual([{ key: "blog", candidates: 4 }]);

    const byKind = JSON.parse(run(["--cluster", "page", "--json"], directory).stdout) as Report;
    expect(byKind.total).toBe(2);
    expect(byKind.clusters).toEqual([{ key: "kind:page", candidates: 2 }]);
  });

  it("excludes anchors already rendered when given --rendered", () => {
    const directory = configDirectory(CONFIG);
    const renderedFile = join(directory, "rendered.json");
    writeFileSync(renderedFile, JSON.stringify([{ from: "/blog/a", to: "/blog/c" }]));

    const result = run(["--rendered", renderedFile, "--json"], directory);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.rendered).toBe(true);
    expect(report.total).toBe(4);
    expect(report.candidates.map((c) => `${c.source}→${c.destination}`)).not.toContain(
      "/blog/a→/blog/c",
    );
  });

  it("matches rendered anchors whose URLs carry a query or hash", () => {
    const directory = configDirectory(CONFIG);
    const renderedFile = join(directory, "rendered.json");
    writeFileSync(
      renderedFile,
      JSON.stringify([{ from: "/blog/a?ref=nav", to: "/blog/c#details" }]),
    );

    const report = JSON.parse(
      run(["--rendered", renderedFile, "--json"], directory).stdout,
    ) as Report;
    expect(report.total).toBe(4);
    expect(report.candidates.map((c) => `${c.source}→${c.destination}`)).not.toContain(
      "/blog/a→/blog/c",
    );
    expect(report.candidates.map((c) => `${c.source}→${c.destination}`)).not.toContain(
      "/blog/c→/blog/a",
    );
  });

  it("renders the human plan with clusters and reasons", () => {
    const directory = configDirectory(CONFIG);
    const result = run([], directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("6 candidate pair(s)");
    expect(result.stdout).toContain("Clusters:");
    expect(result.stdout).toContain("blog");
    expect(result.stdout).toContain("/blog/a → /blog/c");
    expect(result.stdout).toContain('same top-level section "/blog"');
  });

  it("rejects a non-positive --limit", () => {
    const directory = configDirectory(CONFIG);
    const result = run(["--limit", "0"], directory);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--limit must be a positive integer");
  });
});
