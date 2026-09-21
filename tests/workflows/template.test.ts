import { describe, expect, it } from "vitest";

import { TextTemplate } from "../../src/workflows/template";

describe("TextTemplate", () => {
  it("renders an imported-style template through an immutable builder", () => {
    const base = TextTemplate.from("{{greeting}}, {{name}}!");
    const greeting = base.value("greeting", "Hello");

    expect(greeting.value("name", "Saatvik").render()).toBe("Hello, Saatvik!");
    expect(() => base.render()).toThrow("greeting, name");
  });
});
