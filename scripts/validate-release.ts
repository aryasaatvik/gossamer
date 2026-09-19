import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type PackResult = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
};

type PackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly repository: { readonly type: string; readonly url: string };
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly bin: Record<string, string>;
  readonly exports: Record<string, { readonly types: string; readonly import: string }>;
  readonly publishConfig: { readonly access: string; readonly registry: string };
  readonly peerDependencies: Record<string, string>;
  readonly peerDependenciesMeta: Record<string, { readonly optional?: boolean }>;
  readonly devDependencies: Record<string, string>;
};

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type AuditFixtureFinding = {
  readonly scanner: string;
  readonly target: string;
  readonly severity: "structural" | "editorial";
  readonly rule: string;
  readonly message: string;
};

type AuditFixtureReport = {
  readonly schemaVersion: unknown;
  generatedAt: string;
  readonly targets: Array<string>;
  readonly results: Array<{
    readonly scanner: string;
    readonly target: string;
    readonly findings: Array<AuditFixtureFinding>;
  }>;
  readonly findings: Array<AuditFixtureFinding>;
};

const root = path.resolve(import.meta.dir, "..");
const temporary = await mkdtemp(path.join(tmpdir(), "gossamer-release-"));
const packDirectory = path.join(temporary, "pack");
const installDirectory = path.join(temporary, "consumer");
const packageName = "gossamer";
const repositoryUrl = "git+https://github.com/aryasaatvik/gossamer.git";

const run = async (
  command: ReadonlyArray<string>,
  cwd: string,
  options: { readonly env?: Record<string, string | undefined> } = {},
): Promise<RunResult> => {
  const child = Bun.spawn(command, {
    cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const runSuccessfully = async (
  command: ReadonlyArray<string>,
  cwd: string,
  options: { readonly env?: Record<string, string | undefined> } = {},
): Promise<string> => {
  const result = await run(command, cwd, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode})\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
};

const stripAnsi = (output: string): string =>
  output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");

const parsePackOutput = (output: string): ReadonlyArray<PackResult> => {
  const normalized = stripAnsi(output).trim();
  const jsonStart = normalized.lastIndexOf("\n[");
  return JSON.parse(
    jsonStart === -1 ? normalized : normalized.slice(jsonStart + 1),
  ) as ReadonlyArray<PackResult>;
};

const assertPackageIdentity = (manifest: PackageManifest): void => {
  if (manifest.name !== packageName) {
    throw new Error(`Package name must be ${packageName}, received ${manifest.name}`);
  }
  if (manifest.repository.type !== "git" || manifest.repository.url !== repositoryUrl) {
    throw new Error(`Package repository must be ${repositoryUrl}`);
  }
  if (manifest.homepage !== "https://github.com/aryasaatvik/gossamer#readme") {
    throw new Error("Package homepage must point to the owned repository");
  }
  if (manifest.bugs.url !== "https://github.com/aryasaatvik/gossamer/issues") {
    throw new Error("Package bugs URL must point to the owned repository");
  }
  if (
    manifest.publishConfig.access !== "public" ||
    manifest.publishConfig.registry !== "https://registry.npmjs.org"
  ) {
    throw new Error("Package publish configuration must target the public npm registry");
  }
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ gossamer: "./dist/cli.js" })) {
    throw new Error("Package must expose only the gossamer bin from dist/cli.js");
  }

  const expectedExports = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./react": { types: "./dist/react.d.ts", import: "./dist/react.js" },
    "./vite": { types: "./dist/vite.d.ts", import: "./dist/vite.js" },
    "./config": { types: "./dist/config.d.ts", import: "./dist/config.js" },
    "./audit": { types: "./dist/audit.d.ts", import: "./dist/audit.js" },
  };
  if (JSON.stringify(manifest.exports) !== JSON.stringify(expectedExports)) {
    throw new Error("Package exports do not match the supported public entry points");
  }

  for (const peer of ["effect", "@effect/platform-bun", "lighthouse"] as const) {
    if (manifest.peerDependencies[peer] === undefined) {
      throw new Error(`Package must declare ${peer} as a peer dependency`);
    }
    if (manifest.peerDependenciesMeta[peer]?.optional !== true) {
      throw new Error(`${peer} must remain an optional peer dependency`);
    }
  }

  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REF_TYPE === "tag") {
    const expectedTag = `v${manifest.version}`;
    if (process.env.GITHUB_REF_NAME !== expectedTag) {
      throw new Error(`GitHub releases must run from ${expectedTag}`);
    }
  }
};

try {
  await mkdir(packDirectory);
  await mkdir(installDirectory);

  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  assertPackageIdentity(manifest);

  const packOutput = await runSuccessfully(
    [
      "npm",
      "pack",
      "--json",
      "--color=false",
      "--pack-destination",
      packDirectory,
    ],
    root,
    {
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        NO_COLOR: "1",
      },
    },
  );
  const [packed] = parsePackOutput(packOutput);
  if (packed === undefined) throw new Error("npm pack did not produce an artifact");
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    throw new Error("Packed artifact metadata does not match package.json");
  }

  const included = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/react.js",
    "dist/react.d.ts",
    "dist/vite.js",
    "dist/vite.d.ts",
    "dist/config.js",
    "dist/config.d.ts",
    "dist/audit.js",
    "dist/audit.d.ts",
    "dist/cli.js",
    "README.md",
    "LICENSE",
    "package.json",
  ]) {
    if (!included.has(required)) throw new Error(`Packed artifact is missing ${required}`);
  }

  const tarball = path.join(packDirectory, packed.filename);
  await Bun.write(
    path.join(installDirectory, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { [packageName]: `file:${tarball}` },
      },
      null,
      2,
    ),
  );
  await runSuccessfully(
    ["npm", "install", "--ignore-scripts", "--omit=optional"],
    installDirectory,
  );

  const installedRoot = path.join(installDirectory, "node_modules", packageName);
  const installedManifest = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  assertPackageIdentity(installedManifest);
  if (installedManifest.version !== manifest.version) {
    throw new Error("Installed packed artifact version does not match package.json");
  }
  if (
    existsSync(path.join(installDirectory, "node_modules", "effect")) ||
    existsSync(path.join(installDirectory, "node_modules", "@effect", "platform-bun"))
  ) {
    throw new Error("Optional Effect peers were installed into the peer-free consumer fixture");
  }

  const coreSmoke = await runSuccessfully(
    [
      "bun",
      "-e",
      `const seo = await import(${JSON.stringify(packageName)}); if (typeof seo.checkGraph !== "function" || typeof seo.renderSitemap !== "function") throw new Error("core exports missing"); console.log("core exports ok")`,
    ],
    installDirectory,
  );
  if (!coreSmoke.includes("core exports ok")) throw new Error("Core export smoke test failed");

  const executable = path.join(installDirectory, "node_modules", ".bin", "gossamer");
  const missingPeers = await run([executable, "--help"], installDirectory);
  if (
    missingPeers.exitCode !== 1 ||
    !missingPeers.stderr.includes("Effect is an optional peer dependency")
  ) {
    throw new Error("Packed gossamer bin did not explain its missing optional Effect peers");
  }

  await runSuccessfully(
    [
      "npm",
      "install",
      "--no-save",
      "--ignore-scripts",
      `effect@${manifest.devDependencies.effect}`,
      `@effect/platform-bun@${manifest.devDependencies["@effect/platform-bun"]}`,
      `react@${manifest.devDependencies.react}`,
      `vite@${manifest.devDependencies.vite}`,
    ],
    installDirectory,
  );

  const publicExports = await runSuccessfully(
    [
      "bun",
      "-e",
      `await Promise.all([import(${JSON.stringify(packageName)}), import(${JSON.stringify(`${packageName}/react`)}), import(${JSON.stringify(`${packageName}/vite`)}), import(${JSON.stringify(`${packageName}/config`)}), import(${JSON.stringify(`${packageName}/audit`)})]); console.log("public exports ok")`,
    ],
    installDirectory,
  );
  if (!publicExports.includes("public exports ok")) {
    throw new Error("Public export import smoke test failed");
  }

  const help = await runSuccessfully([executable, "--help"], installDirectory);
  if (!help.includes("seo <subcommand>") || !help.includes("audit") || !help.includes("diff") || !help.includes("check") || !help.includes("sitemap")) {
    throw new Error("Packed gossamer bin did not print the expected command tree");
  }
  const version = await runSuccessfully([executable, "--version"], installDirectory);
  const expectedVersion = `seo v${manifest.version}`;
  if (version.trim() !== expectedVersion) {
    throw new Error(`Packed gossamer bin reported ${version.trim()}, expected ${expectedVersion}`);
  }

  await Bun.write(
    path.join(installDirectory, "seo.config.mjs"),
    `import { defineSeoConfig } from ${JSON.stringify(`${packageName}/config`)};\n\nexport default defineSeoConfig({\n  origin: "https://example.com",\n  disallow: [],\n  loadGraph: async () => ({\n    graph: {\n      nodes: new Map([["/", { path: "/", kind: "page", source: "route", policy: { kind: "page" } }]]),\n      edges: [],\n    },\n    dispose: async () => {},\n  }),\n});\n`,
  );
  const checkOutput = await runSuccessfully([executable, "check", "--json"], installDirectory);
  const check = JSON.parse(checkOutput) as { readonly ok?: unknown; readonly structural?: unknown };
  if (check.ok !== true || check.structural !== 0) {
    throw new Error("Packed gossamer check did not validate the representative consumer config");
  }

  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
      if (url.pathname === "/sitemap.xml") {
        return new Response("<urlset/>", { headers: { "content-type": "application/xml" } });
      }
      if (url.pathname === "/llms.txt") return new Response("# Fixture\n");
      return new Response(
        `<!doctype html><title>Representative packed audit fixture</title><meta name="description" content="A representative packed audit fixture with enough descriptive content for deterministic release validation."><link rel="canonical" href="${url.origin}/">`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  try {
    const auditOutput = await runSuccessfully(
      [executable, "audit", fixture.url.href, "--allow-private", "--probe-only", "--json"],
      installDirectory,
    );
    const audit = JSON.parse(auditOutput) as AuditFixtureReport;
    if (audit.schemaVersion !== 1 || audit.findings.length !== 0) {
      throw new Error("Packed gossamer audit did not return the expected clean report");
    }

    const beforePath = path.join(installDirectory, "audit-before.json");
    const afterPath = path.join(installDirectory, "audit-after.json");
    await Bun.write(beforePath, `${JSON.stringify(audit, null, 2)}\n`);
    const after = structuredClone(audit);
    after.generatedAt = "2026-08-30T00:05:00.000Z";
    await Bun.write(afterPath, `${JSON.stringify(after, null, 2)}\n`);
    const unchangedOutput = await runSuccessfully(
      [executable, "diff", beforePath, afterPath, "--json"],
      installDirectory,
    );
    const unchanged = JSON.parse(unchangedOutput) as {
      readonly kind?: unknown;
      readonly outcome?: unknown;
    };
    if (unchanged.kind !== "audit-diff" || unchanged.outcome !== "unchanged") {
      throw new Error("Packed gossamer diff did not ignore timestamp volatility");
    }

    const regression = structuredClone(after);
    const target = regression.targets[0];
    const result = regression.results[0];
    if (target === undefined || result === undefined) {
      throw new Error("Packed audit fixture did not contain a target and scanner result");
    }
    const finding: AuditFixtureFinding = {
      scanner: "rules",
      target,
      severity: "structural",
      rule: "release-fixture-regression",
      message: "Representative structural regression.",
    };
    result.findings.push(finding);
    regression.findings.push(finding);
    await Bun.write(afterPath, `${JSON.stringify(regression, null, 2)}\n`);
    const regressed = await run(
      [executable, "diff", beforePath, afterPath, "--json"],
      installDirectory,
    );
    if (regressed.exitCode !== 1 || !regressed.stderr.includes("1 structural")) {
      throw new Error("Packed gossamer diff did not fail on a structural regression");
    }
    const regressedOutput = JSON.parse(regressed.stdout) as {
      readonly outcome?: unknown;
    };
    if (regressedOutput.outcome !== "regressed") {
      throw new Error("Packed gossamer diff did not preserve JSON output on regression");
    }
  } finally {
    await fixture.stop(true);
  }

  console.log(`Validated ${packed.filename} from an isolated temporary consumer`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
