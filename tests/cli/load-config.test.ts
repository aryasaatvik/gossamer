import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import { loadSeoProjectConfig } from "../../src/cli/load-config";

const directories: Array<string> = [];
const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const load = (timeoutMs?: string) => {
  const root = mkdtempSync(join(tmpdir(), "pagegraph-workflow-config-"));
  directories.push(root);
  writeFileSync(
    join(root, "seo.config.mjs"),
    `export default {
      origin: "https://example.com",
      disallow: [],
      loadGraph: async () => ({ graph: { nodes: new Map(), edges: [] }, dispose: async () => {} }),
      workflows: {
        opencode: {
          configDirectory: ".pagegraph/opencode",
          defaultModel: "test/model",
          ${timeoutMs === undefined ? "" : `timeoutMs: ${timeoutMs},`}
        },
      },
    };`,
  );
  process.chdir(root);
  return Effect.runPromise(loadSeoProjectConfig);
};

describe("OpenCode timeout configuration", () => {
  it("loads the maximum supported per-completion timeout", async () => {
    const project = await load("2147483647");

    expect(project.config.workflows?.opencode.timeoutMs).toBe(2_147_483_647);
  });

  it.each(["0", "-1", "1.5", "2147483648", "NaN"])(
    "rejects invalid timeoutMs %s in plain JavaScript config",
    async (value) => {
      await expect(load(value)).rejects.toThrow("must default-export");
    },
  );

  it("keeps timeoutMs optional for existing config", async () => {
    const project = await load();

    expect(project.config.workflows?.opencode.timeoutMs).toBeUndefined();
  });
});
