import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertWorkflowSkillsAvailable,
  collectExecutorEvidence,
  interactionEventError,
  parseWorkflowStateWithRepair,
  runWorkflowTurn,
  waitForActiveExecutorPlugin,
  waitForIdle,
} from "../../src/workflows/opencode";

const tool = (id: string, name: string, input: unknown, content: unknown, metadata?: unknown) => ({
  type: "tool",
  id,
  name,
  state: { status: "completed", input, content, ...(metadata === undefined ? {} : { metadata }) },
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
      "execute",
      { code: 'return tools.executor.search({ query: "keywords" })' },
      [
        {
          type: "text",
          text: JSON.stringify({
            items: [{ path: "open_seo.cached.keywordIdeas" }],
          }),
        },
      ],
      { toolCalls: [{ tool: "executor.search", status: "completed", input: { query: "keywords" } }] },
    );
    const discovered = tool(
      "provider",
      "execute",
      {
        code: 'return tools["open_seo.cached.keywordIdeas"]({ query: "email api" })',
      },
      [{ type: "text", text: "result" }],
      {
        toolCalls: [
          {
            tool: "open_seo.cached.keywordIdeas",
            status: "completed",
            input: { query: "email api" },
          },
        ],
      },
    );
    const unrelated = tool(
      "other",
      "execute",
      { code: "return tools.files.read({ path: 'README.md' })" },
      [{ type: "text", text: "tools.open_seo.cached.keywordIdeas appears in prose" }],
      { toolCalls: [{ tool: "files.read", status: "completed", input: { path: "README.md" } }] },
    );
    const catalogLookup = tool(
      "catalog",
      "execute",
      { code: 'return search({ query: "other tools" })' },
      [{ type: "text", text: '{"items":[{"path":"dataforseo.serp.live"}]}' }],
      { toolCalls: [{ tool: "search", status: "completed", input: { query: "other tools" } }] },
    );
    const mentionedProvider = tool(
      "mentioned-provider",
      "execute",
      { code: 'return tools.dataforseo.serp.live({ query: "email api" })' },
      [{ type: "text", text: "not invoked" }],
      {
        toolCalls: [
          { tool: "files.read", status: "completed", input: { path: "README.md" } },
        ],
      },
    );
    const transcript = {
      messages: [
        { type: "assistant", content: [search, discovered, unrelated, catalogLookup, mentionedProvider] },
        { type: "assistant", content: [{ type: "text", text: "tools.dataforseo.serp.live" }] },
      ],
    };

    expect(collectExecutorEvidence(transcript)).toEqual({
      searches: [
        {
          tool: "executor.search",
          input: { query: "keywords" },
          output: {
            status: "completed",
            scope: "shared CodeMode execution result",
            content: search.state.content,
          },
        },
      ],
      calls: [
        {
          tool: "open_seo.cached.keywordIdeas",
          input: { query: "email api" },
          output: {
            status: "completed",
            scope: "shared CodeMode execution result",
            content: discovered.state.content,
          },
        },
      ],
    });
  });

  it("does not count failed CodeMode calls or mentioned provider paths", () => {
    const first = tool(
      "search-1",
      "execute",
      { code: 'return tools.executor.search({ query: "keywords" })' },
      [{ type: "text", text: '{"items":[{"path":"open_seo.cached.keywordIdeas"}]}' }],
      { toolCalls: [{ tool: "executor.search", status: "completed", input: { query: "keywords" } }] },
    );
    const second = tool(
      "provider-failed",
      "execute",
      { code: 'return tools["open_seo.cached.keywordIdeas"]({ query: "email api" })' },
      [{ type: "text", text: "tools.open_seo.cached.keywordIdeas was mentioned, not called" }],
      {
        toolCalls: [
          {
            tool: "open_seo.cached.keywordIdeas",
            status: "error",
            input: { query: "email api" },
          },
        ],
      },
    );
    const searchFailure = tool(
      "search-failed",
      "execute",
      { code: 'return tools.search({ query: "serps" })' },
      [{ type: "text", text: '{"items":[{"path":"dataforseo.serp.live"}]}' }],
      { toolCalls: [{ tool: "executor.search", status: "error", input: { query: "serps" } }] },
    );

    expect(
      collectExecutorEvidence({ messages: [{ type: "assistant", content: [first, second, searchFailure] }] }),
    ).toEqual({
      searches: [
        {
          tool: "executor.search",
          input: { query: "keywords" },
          output: {
            status: "completed",
            scope: "shared CodeMode execution result",
            content: first.state.content,
          },
        },
      ],
      calls: [],
    });
  });

  it("does not report completed Executor evidence for an error-only CodeMode attempt", () => {
    const failed = tool(
      "failed-search",
      "execute",
      { code: 'return tools.search({ query: "keywords" })' },
      [{ type: "text", text: "search failed" }],
      { toolCalls: [{ tool: "executor.search", status: "error", input: { query: "keywords" } }] },
    );
    const transcript = { messages: [{ type: "assistant", content: [failed] }] };

    expect(collectExecutorEvidence(transcript)).toEqual({ searches: [], calls: [] });
    expect(transcript.messages[0]?.content[0]).toBe(failed);
  });

  it("attributes direct Executor tool invocations by their actual names", () => {
    const search = tool(
      "search",
      "executor_search",
      { query: "keywords" },
      [{ type: "text", text: '{"items":[{"path":"open_seo.cached.keywordIdeas"}]}' }],
    );
    const provider = tool(
      "provider",
      "open_seo_cached_keywordIdeas",
      { query: "email api" },
      [{ type: "text", text: "result" }],
    );
    const mentionOnly = tool(
      "unrelated",
      "other_tool",
      { note: "tools.open_seo.cached.keywordIdeas would be useful" },
      [{ type: "text", text: "not invoked" }],
    );
    const failedProvider = {
      ...tool("failed-provider", "open_seo_cached_keywordIdeas", { query: "bad" }, null),
      state: { ...tool("failed-provider", "open_seo_cached_keywordIdeas", { query: "bad" }, null).state, status: "error" },
    };

    expect(
      collectExecutorEvidence({
        messages: [{ type: "assistant", content: [search, provider, mentionOnly, failedProvider] }],
      }),
    ).toEqual({
      searches: [{ tool: "executor_search", input: { query: "keywords" }, output: search.state.content }],
      calls: [{ tool: "open_seo_cached_keywordIdeas", input: { query: "email api" }, output: provider.state.content }],
    });
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

  it("applies the deadline to prompt admission and interrupts the session", async () => {
    let promptAborted = false;
    let logCalls = 0;
    let interrupts = 0;
    const host = {
      sessions: {
        prompt: (_input: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const abort = () => {
              promptAborted = true;
              reject(new Error("Prompt request aborted"));
            };
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
          }),
        log: () => {
          logCalls += 1;
          return { async *[Symbol.asyncIterator]() {} };
        },
        interrupt: async () => {
          interrupts += 1;
          return { interrupted: false };
        },
      },
    };

    await expect(
      runWorkflowTurn(host as never, "session-1", "prompt", {
        timeoutMs: 5,
        configuredTimeoutMs: 180_000,
        stage: "prompt admission",
        activity: { modelSteps: 0, completedTools: 0, toolNames: new Map() },
      }),
    ).rejects.toThrow(
      "OpenCode session did not complete within 180000ms during prompt admission; Model steps: 0; completed tools: 0; last activity: none observed during prompt admission. Timeout handling: no active execution to interrupt.",
    );
    expect(promptAborted).toBe(true);
    expect(logCalls).toBe(0);
    expect(interrupts).toBe(1);
  });

  it("reports bounded model and tool activity when the log deadline interrupts execution", async () => {
    let interrupts = 0;
    const host = {
      sessions: {
        prompt: async () => undefined,
        log: (_input: unknown, options: { signal: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "session.step.started",
              data: { model: { providerID: "test", id: "model" } },
              durable: { seq: 1 },
            };
            yield {
              type: "session.tool.input.started",
              data: { id: "tool-1", name: "executor_search" },
              durable: { seq: 2 },
            };
            yield {
              type: "session.tool.called",
              data: { id: "tool-1", input: { secret: "do not retain" } },
              durable: { seq: 3 },
            };
            yield {
              type: "session.tool.success",
              data: {
                id: "tool-1",
                content: [{ type: "text", text: "private output" }],
              },
              durable: { seq: 4 },
            };
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(new Error("Log request aborted"));
              if (options.signal.aborted) abort();
              else options.signal.addEventListener("abort", abort, { once: true });
            });
          },
        }),
        interrupt: async () => {
          interrupts += 1;
          return { interrupted: true };
        },
      },
    };

    let message = "";
    try {
      await runWorkflowTurn(host as never, "session-1", "prompt", {
        timeoutMs: 10,
        configuredTimeoutMs: 180_000,
        stage: "prompt admission",
        activity: { modelSteps: 0, completedTools: 0, toolNames: new Map() },
      });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }

    expect(message).toContain("during model execution");
    expect(message).toContain("Model steps: 1; completed tools: 1");
    expect(message).toContain("session.tool.success");
    expect(message).toContain("last model test/model");
    expect(message).toContain("last tool executor_search (tool-1, succeeded)");
    expect(message).not.toContain("do not retain");
    expect(message).not.toContain("private output");
    expect(interrupts).toBe(1);
  });
});
