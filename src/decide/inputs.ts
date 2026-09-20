/**
 * Batch input reading for `pagegraph decide <family>`. A batch is either a JSON
 * array, a `{ "inputs": [...] }` envelope, or newline-delimited JSON (one input
 * per non-empty line) — from a file argument or stdin. A TTY with no file is an
 * error: the command must never appear to hang waiting for input that will not
 * come from a pipe.
 */

/** Parse a batch of raw inputs from text. Throws a plain `Error` on malformed input. */
export const decodeInputsText = (text: string): ReadonlyArray<unknown> => {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("no input provided");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const lines = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 1) {
      try {
        return lines.map((line) => JSON.parse(line) as unknown);
      } catch {
        throw error;
      }
    }
    throw error;
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { inputs?: unknown }).inputs)) {
    return (parsed as { inputs: ReadonlyArray<unknown> }).inputs;
  }
  throw new Error('expected a JSON array, a { "inputs": [...] } envelope, or JSONL');
};
