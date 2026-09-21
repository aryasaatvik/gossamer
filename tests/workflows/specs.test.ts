import { describe, expect, it } from "vitest";

import { classify as classifyArchitecture } from "../../src/workflows/specs/architecture";
import { classify as classifyLinks } from "../../src/workflows/specs/links";
import { classify as classifySchema } from "../../src/workflows/specs/schema";

const action = (label: string) => ({ label, probabilities: { [label]: 0.95 } });

describe("workflow prerequisite gates", () => {
  it("keeps architecture unchanged when ownership or hierarchy is unsupported", () => {
    expect(
      classifyArchitecture(
        { ownership: { probability: 0.05 }, hierarchy: { probability: 0.95 }, action: action("move") },
        0.7,
      ),
    ).toBe("keep");
  });

  it("skips links that are not useful or supported", () => {
    expect(
      classifyLinks(
        { useful: { probability: 0.95 }, supported: { probability: 0.05 }, action: action("add") },
        0.7,
      ),
    ).toBe("skip");
  });

  it("keeps schema unchanged when its page type or evidence is unsupported", () => {
    expect(
      classifySchema(
        {
          pageTypeSupported: { probability: 0.05 },
          evidenceComplete: { probability: 0.95 },
          action: action("add"),
        },
        0.7,
      ),
    ).toBe("keep");
  });
});
