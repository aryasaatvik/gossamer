import { resolve } from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { SeoWorkflowOpenCodeConfig } from "../config";
import type { ExecutorEvidence, ExecutorEvidenceRecord } from "./model";
import { KeywordResearchStateSchema, type KeywordResearchStateInput } from "./specs/keywords";

export interface WorkflowHostResult {
  readonly state: KeywordResearchStateInput;
  readonly sessionId: string;
  readonly transcript: unknown;
  readonly executor: ExecutorEvidence;
}

export interface WorkflowHost {
  readonly model: { readonly provider: string; readonly id: string };
  readonly researchKeywords: (prompt: string) => Promise<WorkflowHostResult>;
  readonly close: () => Promise<void>;
}

type EmbeddedHost = Awaited<ReturnType<typeof import("@opencode/sdk").OpenCode.create>>;

const parseModel = (reference: string): { readonly provider: string; readonly id: string } => {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) {
    throw new Error(`Invalid OpenCode model reference "${reference}"; expected provider/model.`);
  }
  return { provider: reference.slice(0, slash), id: reference.slice(slash + 1) };
};

const decodeState = Schema.decodeUnknownSync(KeywordResearchStateSchema);

const TextPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const AssistantMessageSchema = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
});
const TranscriptSchema = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });
const decodeTextPart = Schema.decodeUnknownOption(TextPartSchema);
const decodeAssistantMessage = Schema.decodeUnknownOption(AssistantMessageSchema);
const decodeTranscript = Schema.decodeUnknownSync(TranscriptSchema);

const parseState = (transcript: unknown): KeywordResearchStateInput => {
  const candidates = decodeTranscript(transcript).messages.flatMap((message) => {
    const assistant = decodeAssistantMessage(message);
    if (Option.isNone(assistant)) return [];
    return assistant.value.content.flatMap((part) => {
      const text = decodeTextPart(part);
      return Option.isSome(text) && text.value.text.includes("{") ? [text.value.text] : [];
    });
  });
  for (const text of candidates.reverse()) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return decodeState(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // Continue to the previous text block: prompts can also contain JSON evidence.
    }
  }
  throw new Error("The SEO agent did not return a valid keyword-research JSON object.");
};

const ToolPartSchema = Schema.Struct({
  type: Schema.Literal("tool"),
  id: Schema.String,
  name: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    input: Schema.optionalKey(Schema.Unknown),
    content: Schema.optionalKey(Schema.Unknown),
  }),
});
type ToolPart = typeof ToolPartSchema.Type;
const decodeToolPart = Schema.decodeUnknownOption(ToolPartSchema);

const toolParts = (transcript: unknown): ReadonlyArray<ToolPart> => {
  return decodeTranscript(transcript).messages.flatMap((message) => {
    const assistant = decodeAssistantMessage(message);
    if (Option.isNone(assistant)) return [];
    return assistant.value.content.flatMap((part) => {
      const decoded = decodeToolPart(part);
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
  });
};

const toolText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toolText).join("\n");
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
  return Object.values(record).map(toolText).join("\n");
};

const pathsIn = (value: unknown): ReadonlyArray<string> =>
  [...toolText(value).matchAll(/tools\.([A-Za-z0-9_.-]+)/g)].map((match) => match[1] ?? "").filter(Boolean);

const evidenceRecord = (part: ToolPart): ExecutorEvidenceRecord => ({
  tool: part.name,
  input: part.state.input ?? null,
  output: part.state.content ?? null,
});

export const collectExecutorEvidence = (transcript: unknown): ExecutorEvidence => {
  const parts = toolParts(transcript);
  const discovered = new Set<string>();
  const searches: Array<ExecutorEvidenceRecord> = [];
  const calls: Array<ExecutorEvidenceRecord> = [];
  for (const part of parts) {
    const inputPaths = pathsIn(part.state.input);
    const isSearch =
      part.name === "executor_search" ||
      part.name === "executor.search" ||
      inputPaths.some((path) => path === "executor.search");
    if (isSearch) {
      for (const path of pathsIn(part.state.content)) if (path !== "executor.search") discovered.add(path);
      searches.push(evidenceRecord(part));
      continue;
    }
    const directlyDiscovered = [...discovered].some(
      (path) => part.name === path || part.name === path.replaceAll(".", "_") || inputPaths.includes(path),
    );
    if (directlyDiscovered) calls.push(evidenceRecord(part));
  }
  return { searches, calls };
};

export const interactionEventError = (event: unknown, sessionId: string): Error | undefined => {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const data = record["data"];
  if (data === null || typeof data !== "object") return undefined;
  const eventData = data as Record<string, unknown>;
  if (record["type"] === "permission.asked" && eventData["sessionID"] === sessionId) {
    return new Error("OpenCode requested permission; embedded PageGraph workflows are noninteractive.");
  }
  if (record["type"] === "form.created") {
    const form = eventData["form"];
    if (form !== null && typeof form === "object" && (form as Record<string, unknown>)["sessionID"] === sessionId) {
      return new Error("OpenCode requested a form; embedded PageGraph workflows are noninteractive.");
    }
  }
  return undefined;
};

const waitForIdle = async (
  host: EmbeddedHost,
  sessionId: string,
  timeoutMs: number,
): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const event of host.sessions.log(
      { sessionID: sessionId, follow: true },
      { signal: controller.signal },
    )) {
      const interactionError = interactionEventError(event, sessionId);
      if (interactionError !== undefined) throw interactionError;
      if (event.type === "session.execution.succeeded" && event.data.sessionID === sessionId) return;
      if (event.type === "session.execution.failed" && event.data.sessionID === sessionId) {
        throw new Error(`OpenCode session failed: ${JSON.stringify(event.data.error)}`);
      }
      if (event.type === "session.execution.interrupted" && event.data.sessionID === sessionId) {
        throw new Error(`OpenCode session was interrupted: ${event.data.reason}.`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error("OpenCode session log ended before the SEO agent completed.");
};

export const acquireWorkflowHost = async (options: {
  readonly root: string;
  readonly config: SeoWorkflowOpenCodeConfig;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<WorkflowHost> => {
  const model = parseModel(options.model ?? options.config.defaultModel);
  const configDirectory = resolve(options.root, options.config.configDirectory);
  const { OpenCode } = await import("@opencode/sdk");
  const host = await OpenCode.create({
    events: { persist: true },
    config: { directory: configDirectory, project: false },
  });
  try {
    const location = { directory: options.root };
    const plugins = await host.plugin.list({ location });
    const executor = plugins.data.find(
      (plugin) =>
        JSON.stringify(plugin.source).toLowerCase().includes("executor") &&
        plugin.state.status === "active",
    );
    if (executor === undefined) {
      throw new Error(
        `No active Executor plugin was discovered in ${configDirectory}; agentic SEO workflows require Executor.`,
      );
    }

    return {
      model,
      researchKeywords: async (prompt) => {
        const session = await host.sessions.create({
          title: "PageGraph keyword research",
          agent: "seo",
          model: { providerID: model.provider, id: model.id },
          location,
        });
        await host.sessions.prompt({
          sessionID: session.id,
          text: prompt,
          skills: [{ id: "keyword-research" }],
        });
        await waitForIdle(host, session.id, options.timeoutMs ?? 180_000);
        const transcript = await host.sessions.export({ sessionID: session.id, sanitize: false });
        const executorEvidence = collectExecutorEvidence(transcript);
        if (executorEvidence.searches.length === 0 || executorEvidence.calls.length === 0) {
          throw new Error(
            "The SEO agent returned without searching Executor and calling a discovered tool.",
          );
        }
        return {
          state: parseState(transcript),
          sessionId: session.id,
          transcript,
          executor: executorEvidence,
        };
      },
      close: () => host.close(),
    };
  } catch (cause) {
    await host.close();
    throw cause;
  }
};
