import { describe, expect, it } from "vitest";

import { collectExecutorEvidence, interactionEventError } from "../../src/workflows/opencode";

const tool = (id: string, name: string, input: unknown, content: unknown) => ({
  type: "tool",
  id,
  name,
  state: { status: "completed", input, content },
  time: { created: 1 },
});

describe("OpenCode workflow evidence", () => {
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
      calls: [{ tool: "codemode", input: discovered.state.input, output: discovered.state.content }],
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
});
