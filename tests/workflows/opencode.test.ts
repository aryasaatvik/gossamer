import { describe, expect, it } from "vitest";

import { collectExecutorCalls, nonInteractiveEventError } from "../../src/workflows/opencode";

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
      { code: 'return tools.open_seo.cached.keywordIdeas({ query: "email api" })' },
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

    expect(collectExecutorCalls(transcript)).toEqual([search, discovered]);
  });

  it("fails noninteractive workflows on permission and form requests", () => {
    expect(
      nonInteractiveEventError(
        { type: "permission.asked", data: { sessionID: "session-1" } },
        "session-1",
      )?.message,
    ).toContain("--no-input");
    expect(
      nonInteractiveEventError(
        { type: "form.created", data: { form: { sessionID: "session-1" } } },
        "session-1",
      )?.message,
    ).toContain("interactive input");
    expect(
      nonInteractiveEventError(
        { type: "form.created", data: { form: { sessionID: "other" } } },
        "session-1",
      ),
    ).toBeUndefined();
  });
});
