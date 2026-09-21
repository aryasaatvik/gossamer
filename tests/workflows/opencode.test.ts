import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertWorkflowSkillsAvailable,
  collectExecutorEvidence,
  interactionEventError,
  parseWorkflowStateWithRepair,
  waitForActiveExecutorPlugin,
  waitForIdle,
} from "../../src/workflows/opencode";

const tool = (id: string, name: string, input: unknown, content: unknown) => ({
  type: "tool",
  id,
  name,
  state: { status: "completed", input, content },
  time: { created: 1 },
});

describe("OpenCode workflow evidence", () => {
  it("repairs a completed turn that omitted its workflow JSON", async () => {
    const invalid = {
      messages: [{ type: "assistant", content: [{ type: "text", text: "Done." }] }],
    };
    const repaired = {
      messages: [
        ...invalid.messages,
        { type: "assistant", content: [{ type: "text", text: '{"items":[]}' }] },
      ],
    };
    let repairs = 0;

    await expect(
      parseWorkflowStateWithRepair(invalid, async () => {
        repairs += 1;
        return repaired;
      }),
    ).resolves.toEqual({ state: { items: [] }, transcript: repaired });
    expect(repairs).toBe(1);
  });

  it("does not start a repair turn when the workflow JSON is already valid", async () => {
    const transcript = {
      messages: [{ type: "assistant", content: [{ type: "text", text: '{"items":[]}' }] }],
    };
    let repairs = 0;

    await expect(
      parseWorkflowStateWithRepair(transcript, async () => {
        repairs += 1;
        return transcript;
      }),
    ).resolves.toEqual({ state: { items: [] }, transcript });
    expect(repairs).toBe(0);
  });

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
      [
        {
          type: "text",
          text: JSON.stringify({
            items: [{ path: "open_seo.cached.keywordIdeas" }, { path: "dataforseo.serp.live" }],
            metadata: "tools.files.read is available outside this search result",
          }),
        },
      ],
    );
    const discovered = tool(
      "provider",
      "codemode",
      {
        code: 'return tools["open_seo.cached.keywordIdeas"]({ query: "email api" })',
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
      [{ type: "text", text: '{"items":[{"path":"open_seo.cached.keywordIdeas"}]}' }],
    );
    const second = tool(
      "search-2",
      "codemode",
      { code: 'return tools.executor.search({ query: "serps" })' },
      [{ type: "text", text: '{"items":[{"path":"dataforseo.serp.live"}]}' }],
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

  it("reports the workflow deadline instead of the SDK transport wrapper", async () => {
    const host = {
      sessions: {
        log: (_input: unknown, options: { signal: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("Transport")), {
                once: true,
              });
            });
            if (false) yield undefined;
          },
        }),
      },
    };

    await expect(waitForIdle(host as never, "session-1", { timeoutMs: 5 })).rejects.toThrow(
      "OpenCode session did not complete within 5ms.",
    );

    await expect(
      waitForIdle(host as never, "session-1", {
        timeoutMs: 5,
        configuredTimeoutMs: 180_000,
      }),
    ).rejects.toThrow("OpenCode session did not complete within 180000ms.");
  });
});
