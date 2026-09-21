import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertWorkflowSkillsAvailable,
  collectExecutorEvidence,
  interactionEventError,
  waitForActiveExecutorPlugin,
} from "../../src/workflows/opencode";

const tool = (id: string, name: string, input: unknown, content: unknown) => ({
  type: "tool",
  id,
  name,
  state: { status: "completed", input, content },
  time: { created: 1 },
});

describe("OpenCode workflow evidence", () => {
  it("requires the attached workflow skill and its Executor reference", () => {
    const root = mkdtempSync(join(tmpdir(), "pagegraph-opencode-preset-"));
    try {
      expect(() => assertWorkflowSkillsAvailable(root, ["content-analysis"])).toThrow(
        "Run `pagegraph init`",
      );

      const skill = join(root, "skills", "content-analysis");
      mkdirSync(join(skill, "references"), { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), "# Content Analysis\n");
      expect(() => assertWorkflowSkillsAvailable(root, ["content-analysis"])).toThrow(
        "references/executor.md",
      );

      writeFileSync(join(skill, "references", "executor.md"), "# Executor Starters\n");
      expect(() => assertWorkflowSkillsAvailable(root, ["content-analysis"])).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attributes only structured calls to tools returned by Executor discovery", () => {
    const search = tool(
      "search",
      "codemode",
      { code: 'return tools.executor.search({ query: "keywords" })' },
      [{ type: "text", text: "tools.open_seo.cached.keywordIdeas\ntools.dataforseo.serp.live" }],
    );
    const discovered = tool(
      "provider",
      "codemode",
      {
        code: 'const path = "open_seo.cached.keywordIdeas"; return call(path, { query: "email api" })',
      },
      [{ type: "text", text: "result" }],
    );
    const unrelated = tool(
      "other",
      "codemode",
      { code: "return tools.files.read({ path: 'README.md' })" },
      [{ type: "text", text: "tools.open_seo.cached.keywordIdeas appears in prose" }],
    );
    const transcript = {
      messages: [
        { type: "assistant", content: [search, discovered, unrelated] },
        { type: "assistant", content: [{ type: "text", text: "tools.dataforseo.serp.live" }] },
      ],
    };

    expect(collectExecutorEvidence(transcript)).toEqual({
      searches: [{ tool: "codemode", input: search.state.input, output: search.state.content }],
      calls: [
        { tool: "codemode", input: discovered.state.input, output: discovered.state.content },
      ],
    });
  });

  it("does not treat repeated catalog searches as provider calls", () => {
    const first = tool(
      "search-1",
      "codemode",
      { code: 'return tools.executor.search({ query: "keywords" })' },
      [{ type: "text", text: "tools.open_seo.cached.keywordIdeas" }],
    );
    const second = tool(
      "search-2",
      "codemode",
      { code: 'return tools.executor.search({ query: "serps" })' },
      [{ type: "text", text: "tools.dataforseo.serp.live" }],
    );

    expect(
      collectExecutorEvidence({ messages: [{ type: "assistant", content: [first, second] }] }),
    ).toMatchObject({ searches: [{ tool: "codemode" }, { tool: "codemode" }], calls: [] });
  });

  it("fails immediately on permission and form requests", () => {
    expect(
      interactionEventError(
        { type: "permission.asked", data: { sessionID: "session-1" } },
        "session-1",
      )?.message,
    ).toContain("noninteractive");
    expect(
      interactionEventError(
        { type: "form.created", data: { form: { sessionID: "session-1" } } },
        "session-1",
      )?.message,
    ).toContain("noninteractive");
    expect(
      interactionEventError(
        { type: "form.created", data: { form: { sessionID: "other" } } },
        "session-1",
      ),
    ).toBeUndefined();
  });

  it("waits for the configured Executor plugin to become active", async () => {
    const responses = [
      [],
      [{ source: { type: "local", path: "/plugins/executor" }, state: { status: "loading" } }],
      [{ source: { type: "local", path: "/plugins/executor" }, state: { status: "active" } }],
    ];
    let calls = 0;

    await expect(
      waitForActiveExecutorPlugin({
        list: async () => responses[Math.min(calls++, responses.length - 1)]!,
        sleep: async () => {},
      }),
    ).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it("fails closed at the activation deadline", async () => {
    let time = 0;
    let calls = 0;

    await expect(
      waitForActiveExecutorPlugin({
        list: async () => {
          calls += 1;
          return [];
        },
        timeoutMs: 500,
        pollMs: 200,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).resolves.toBe(false);
    expect(time).toBe(500);
    expect(calls).toBe(3);
  });
});
