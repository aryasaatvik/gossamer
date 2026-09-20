import { describe, expect, it } from "vitest";

import { decodeInputsText } from "../../src/decide/inputs";

describe("decodeInputsText", () => {
  it("reads a JSON array", () => {
    expect(decodeInputsText('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("reads a { inputs: [...] } envelope", () => {
    expect(decodeInputsText('{"inputs":[{"a":1}]}')).toEqual([{ a: 1 }]);
  });

  it("reads newline-delimited JSON", () => {
    expect(decodeInputsText('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("accepts an empty array", () => {
    expect(decodeInputsText("[]")).toEqual([]);
  });

  it("rejects empty input", () => {
    expect(() => decodeInputsText("   ")).toThrow("no input provided");
  });

  it("rejects JSON that is neither an array nor an inputs envelope", () => {
    expect(() => decodeInputsText('{"a":1}')).toThrow("expected a JSON array");
  });

  it("rejects malformed text", () => {
    expect(() => decodeInputsText("{ not json")).toThrow();
  });
});
