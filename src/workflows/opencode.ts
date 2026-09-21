import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { SeoWorkflowOpenCodeConfig } from "../config";
import type { ExecutorEvidence, ExecutorEvidenceRecord } from "./model";

export interface WorkflowHostResult {
  readonly state: unknown;
  readonly sessionId: string;
  readonly transcript: unknown;
  readonly executor: ExecutorEvidence;
}

export interface WorkflowHost {
  readonly model: { readonly provider: string; readonly id: string };
  readonly research: (
    prompt: string,
    options: WorkflowPromptOptions,
  ) => Promise<WorkflowHostResult>;
  readonly continue: (
    sessionId: string,
    prompt: string,
    options: WorkflowPromptOptions,
  ) => Promise<WorkflowHostResult>;
  readonly close: () => Promise<void>;
}

type EmbeddedHost = Awaited<ReturnType<typeof import("@opencode/sdk").OpenCode.create>>;

interface PluginListItem {
  readonly source: unknown;
  readonly state: { readonly status: string };
}

const isActiveExecutorPlugin = (plugin: PluginListItem): boolean =>
  JSON.stringify(plugin.source).toLowerCase().includes("executor") &&
  plugin.state.status === "active";

export const waitForActiveExecutorPlugin = async (options: {
  readonly list: () => Promise<ReadonlyArray<PluginListItem>>;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<boolean> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  do {
    if ((await options.list()).some(isActiveExecutorPlugin)) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
    if (now() >= deadline) return false;
  } while (true);
};

export const assertWorkflowSkillsAvailable = (
  configDirectory: string,
  skills: ReadonlyArray<string>,
): void => {
  const missing = skills.flatMap((skill) =>
    [
      resolve(configDirectory, "skills", skill, "SKILL.md"),
      resolve(configDirectory, "skills", skill, "references", "executor.md"),
    ].filter((file) => !existsSync(file)),
  );
  if (missing.length === 0) return;
  throw new Error(
    [
      "The PageGraph OpenCode preset is missing files required by this workflow:",
      ...missing.map((file) => `- ${file}`),
      "Run `pagegraph init` to add missing preset files; existing user-owned files will not be overwritten.",
    ].join("\n"),
  );
};

export interface WorkflowPermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface WorkflowPromptOptions {
  readonly skills: ReadonlyArray<string>;
  readonly permissions?: ReadonlyArray<WorkflowPermissionRule> | undefined;
}

const parseModel = (reference: string): { readonly provider: string; readonly id: string } => {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) {
    throw new Error(`Invalid OpenCode model reference "${reference}"; expected provider/model.`);
  }
  return { provider: reference.slice(0, slash), id: reference.slice(slash + 1) };
};

const TextPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const AssistantMessageSchema = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
});
const TranscriptSchema = Schema.Struct({ messages: Schema.Array(Schema.Unknown) });
const decodeTextPart = Schema.decodeUnknownOption(TextPartSchema);
const decodeAssistantMessage = Schema.decodeUnknownOption(AssistantMessageSchema);
const decodeTranscript = Schema.decodeUnknownSync(TranscriptSchema);

export const parseWorkflowState = (transcript: unknown): unknown => {
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
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Continue to the previous assistant text block.
    }
  }
  throw new Error("The SEO agent did not return a valid workflow JSON object.");
};

export const parseWorkflowStateWithRepair = async (
  transcript: unknown,
  repair: () => Promise<unknown>,
): Promise<{ readonly state: unknown; readonly transcript: unknown }> => {
  try {
    return { state: parseWorkflowState(transcript), transcript };
  } catch {
    const repaired = await repair();
    return { state: parseWorkflowState(repaired), transcript: repaired };
  }
};

const STATE_REPAIR_PROMPT = [
  "Your previous turn did not end with the workflow JSON object requested by the original prompt.",
  "Do not call tools, add commentary, or wrap the response in Markdown.",
  "Return only one valid JSON object matching the original JSON Schema, using the evidence already collected.",
].join(" ");

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

const toolParts = (transcript: unknown): ReadonlyArray<ToolPart> =>
  decodeTranscript(transcript).messages.flatMap((message) => {
    const assistant = decodeAssistantMessage(message);
    if (Option.isNone(assistant)) return [];
    return assistant.value.content.flatMap((part) => {
      const decoded = decodeToolPart(part);
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
  });

const toolText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toolText).join("\n");
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
  return Object.values(record).map(toolText).join("\n");
};

const pathsIn = (value: unknown): ReadonlyArray<string> =>
  [...toolText(value).matchAll(/tools\.([A-Za-z0-9_.-]+)/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);

const evidenceRecord = (part: ToolPart): ExecutorEvidenceRecord => ({
  tool: part.name,
  input: part.state.input ?? null,
  output: part.state.content ?? null,
});

export const collectExecutorEvidence = (transcript: unknown): ExecutorEvidence => {
  const discovered = new Set<string>();
  const searches: Array<ExecutorEvidenceRecord> = [];
  const calls: Array<ExecutorEvidenceRecord> = [];
  for (const part of toolParts(transcript)) {
    const inputPaths = pathsIn(part.state.input);
    const inputText = toolText(part.state.input);
    const isSearch =
      part.name === "executor_search" ||
      part.name === "executor.search" ||
      inputPaths.some((path) => path === "executor.search");
    if (isSearch) {
      for (const path of pathsIn(part.state.content)) {
        if (path !== "executor.search") discovered.add(path);
      }
      searches.push(evidenceRecord(part));
      continue;
    }
    const directlyDiscovered = [...discovered].some(
      (path) =>
        part.name === path ||
        part.name === path.replaceAll(".", "_") ||
        inputPaths.includes(path) ||
        inputText.includes(path),
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
    return new Error(
      "OpenCode requested permission; embedded PageGraph workflows are noninteractive.",
    );
  }
  if (record["type"] === "form.created") {
    const form = eventData["form"];
    if (
      form !== null &&
      typeof form === "object" &&
      (form as Record<string, unknown>)["sessionID"] === sessionId
    ) {
      return new Error(
        "OpenCode requested a form; embedded PageGraph workflows are noninteractive.",
      );
    }
  }
  return undefined;
};

export const waitForIdle = async (
  host: EmbeddedHost,
  sessionId: string,
  options: {
    readonly timeoutMs: number;
    readonly configuredTimeoutMs?: number | undefined;
    readonly after?: number | undefined;
  },
): Promise<number> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    for await (const event of host.sessions.log(
      { sessionID: sessionId, follow: true, after: options.after },
      { signal: controller.signal },
    )) {
      const interactionError = interactionEventError(event, sessionId);
      if (interactionError !== undefined) throw interactionError;
      if (event.type === "session.execution.succeeded" && event.data.sessionID === sessionId) {
        return event.durable.seq;
      }
      if (event.type === "session.execution.failed" && event.data.sessionID === sessionId) {
        throw new Error(`OpenCode session failed: ${JSON.stringify(event.data.error)}`);
      }
      if (event.type === "session.execution.interrupted" && event.data.sessionID === sessionId) {
        throw new Error(`OpenCode session was interrupted: ${event.data.reason}.`);
      }
    }
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(
        `OpenCode session did not complete within ${options.configuredTimeoutMs ?? options.timeoutMs}ms.`,
        { cause },
      );
    }
    throw cause;
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
    const executorReady = await waitForActiveExecutorPlugin({
      list: async () => (await host.plugin.list({ location })).data,
    });
    if (!executorReady) {
      throw new Error(
        `No active Executor plugin was discovered in ${configDirectory}; agentic SEO workflows require Executor.`,
      );
    }

    const cursors = new Map<string, number>();
    const complete = async (
      sessionId: string,
      prompt: string,
      workflowOptions: WorkflowPromptOptions,
    ): Promise<WorkflowHostResult> => {
      assertWorkflowSkillsAvailable(configDirectory, workflowOptions.skills);
      if (workflowOptions.permissions !== undefined) {
        await host.sessions.update({
          sessionID: sessionId,
          permissions: [...workflowOptions.permissions],
        });
      }
      const configuredTimeoutMs = options.timeoutMs ?? 180_000;
      const deadline = Date.now() + configuredTimeoutMs;
      const remaining = (): number => Math.max(0, deadline - Date.now());
      await host.sessions.prompt({
        sessionID: sessionId,
        text: prompt,
        skills: workflowOptions.skills.map((id) => ({ id })),
      });
      let cursor = await waitForIdle(host, sessionId, {
        timeoutMs: remaining(),
        configuredTimeoutMs,
        after: cursors.get(sessionId),
      });
      cursors.set(sessionId, cursor);
      let transcript = await host.sessions.export({ sessionID: sessionId, sanitize: false });
      const parsed = await parseWorkflowStateWithRepair(transcript, async () => {
        const priorPermissions = [...(workflowOptions.permissions ?? [])];
        await host.sessions.update({
          sessionID: sessionId,
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        });
        try {
          await host.sessions.prompt({ sessionID: sessionId, text: STATE_REPAIR_PROMPT });
          cursor = await waitForIdle(host, sessionId, {
            timeoutMs: remaining(),
            configuredTimeoutMs,
            after: cursor,
          });
          cursors.set(sessionId, cursor);
          transcript = await host.sessions.export({ sessionID: sessionId, sanitize: false });
          return transcript;
        } finally {
          await host.sessions.update({ sessionID: sessionId, permissions: priorPermissions });
        }
      });
      return {
        state: parsed.state,
        sessionId,
        transcript: parsed.transcript,
        executor: collectExecutorEvidence(parsed.transcript),
      };
    };

    return {
      model,
      research: async (prompt, workflowOptions) => {
        const session = await host.sessions.create({
          title: "PageGraph SEO workflow",
          agent: "seo",
          model: { providerID: model.provider, id: model.id },
          location,
          permissions:
            workflowOptions.permissions === undefined
              ? undefined
              : [...workflowOptions.permissions],
        });
        const result = await complete(session.id, prompt, workflowOptions);
        if (result.executor.searches.length === 0 || result.executor.calls.length === 0) {
          throw new Error(
            "The SEO agent returned without searching Executor and calling a discovered tool.",
          );
        }
        return result;
      },
      continue: (sessionId, prompt, workflowOptions) =>
        complete(sessionId, prompt, workflowOptions),
      close: () => host.close(),
    };
  } catch (cause) {
    await host.close();
    throw cause;
  }
};
