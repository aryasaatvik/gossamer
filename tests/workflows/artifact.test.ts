import { describe, expect, it } from "vitest";

import { createRunId } from "../../src/workflows/artifact";

describe("workflow artifacts", () => {
  it("uses a collision-resistant suffix when timestamps match", () => {
    const started = new Date("2026-09-21T10:00:00.000Z");

    expect(createRunId(started, "research.keywords", "aaaaaaaa-0000-4000-8000-000000000000")).not.toBe(
      createRunId(started, "research.keywords", "bbbbbbbb-0000-4000-8000-000000000000"),
    );
  });
});
