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
type WorkflowLogEvent = ReturnType<EmbeddedHost["sessions"]["log"]> extends AsyncIterable<infer Event>
  ? Event
  : never;

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
    error: Schema.optionalKey(Schema.Unknown),
    metadata: Schema.optionalKey(Schema.Unknown),
  }),
});
type ToolPart = typeof ToolPartSchema.Type;
const decodeToolPart = Schema.decodeUnknownOption(ToolPartSchema);

const CodeModeCallSchema = Schema.Struct({
  tool: Schema.String,
  status: Schema.Literals(["running", "completed", "error"]),
  input: Schema.optionalKey(Schema.Unknown),
});
const CodeModeMetadataSchema = Schema.Struct({ toolCalls: Schema.Array(CodeModeCallSchema) });
type CodeModeCall = typeof CodeModeCallSchema.Type;
const decodeCodeModeMetadata = Schema.decodeUnknownOption(CodeModeMetadataSchema);

const toolParts = (transcript: unknown): ReadonlyArray<ToolPart> =>
  decodeTranscript(transcript).messages.flatMap((message) => {
    const assistant = decodeAssistantMessage(message);
    if (Option.isNone(assistant)) return [];
    return assistant.value.content.flatMap((part) => {
      const decoded = decodeToolPart(part);
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
  });

const toolPathPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

const pathsInSearchOutput = (value: unknown): ReadonlyArray<string> => {
  const found = new Set<string>();
  const visit = (current: unknown, pathField = false): void => {
    if (typeof current === "string") {
      if (pathField) {
        const candidate = current.startsWith("tools.") ? current.slice("tools.".length) : current;
        if (toolPathPattern.test(candidate)) found.add(candidate);
      }
      try {
        visit(JSON.parse(current));
      } catch {
        // Search output can include ordinary prose alongside structured results.
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) visit(nested, key === "path");
  };
  visit(value);
  return [...found];
};

const evidenceRecord = (part: ToolPart): ExecutorEvidenceRecord => ({
  tool: part.name,
  input: part.state.input ?? null,
  output: part.state.content ?? part.state.error ?? null,
});

export const collectExecutorEvidence = (transcript: unknown): ExecutorEvidence => {
  const discovered = new Set<string>();
  const searches: Array<ExecutorEvidenceRecord> = [];
  const calls: Array<ExecutorEvidenceRecord> = [];
  for (const part of toolParts(transcript)) {
    const metadata = decodeCodeModeMetadata(part.state.metadata);
    if (Option.isSome(metadata)) {
      const invocations = metadata.value.toolCalls;
      for (const invocation of invocations) {
        if (invocation.status !== "completed") continue;
        const record = codeModeEvidenceRecord(invocation, part.state.content);
        if (invocation.tool === "executor.search") {
          for (const path of pathsInSearchOutput(part.state.content)) {
            if (path !== "executor.search") discovered.add(path);
          }
          searches.push(record);
          continue;
        }
        if ([...discovered].some((path) => matchesToolPath(invocation.tool, path))) calls.push(record);
      }
      continue;
    }
    if (
      part.state.status === "completed" &&
      (part.name === "executor_search" || part.name === "executor.search")
    ) {
      for (const path of pathsInSearchOutput(part.state.content)) {
        if (path !== "executor.search") discovered.add(path);
      }
      searches.push(evidenceRecord(part));
      continue;
    }
    const directlyDiscovered =
      part.state.status === "completed" &&
      [...discovered].some((path) => matchesToolPath(part.name, path));
    if (directlyDiscovered) calls.push(evidenceRecord(part));
  }
  return { searches, calls };
};

const codeModeEvidenceRecord = (
  invocation: CodeModeCall,
  codeModeOutput: unknown,
): ExecutorEvidenceRecord => ({
  tool: invocation.tool,
  input: invocation.input ?? null,
  output: { status: invocation.status, scope: "shared CodeMode execution result", content: codeModeOutput ?? null },
});

const matchesToolPath = (tool: string, path: string): boolean =>
  tool === path || tool === path.replaceAll(".", "_");

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

interface WorkflowActivity {
  modelSteps: number;
  completedTools: number;
  readonly toolNames: Map<string, string>;
  lastModel?: string;
  lastTool?: {
    readonly id: string;
    readonly name: string;
    readonly status: "input" | "called" | "succeeded" | "failed";
  };
  lastActivity?: { readonly type: string; readonly at: string; readonly seq?: number };
}

const recordWorkflowActivity = (activity: WorkflowActivity, event: WorkflowLogEvent): void => {
  if (event.type === "log.synced") return;
  activity.lastActivity = {
    type: event.type,
    at: new Date().toISOString(),
    seq: event.durable.seq,
  };
  if (event.type === "session.step.started") {
    activity.modelSteps += 1;
    activity.lastModel = `${event.data.model.providerID}/${event.data.model.id}`;
    return;
  }
  if (event.type === "session.tool.input.started") {
    activity.toolNames.set(event.data.id, event.data.name);
    activity.lastTool = { id: event.data.id, name: event.data.name, status: "input" };
    return;
  }
  if (event.type === "session.tool.called") {
    activity.lastTool = {
      id: event.data.id,
      name: activity.toolNames.get(event.data.id) ?? event.data.id,
      status: "called",
    };
    return;
  }
  if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
    activity.completedTools += 1;
    activity.lastTool = {
      id: event.data.id,
      name: activity.toolNames.get(event.data.id) ?? event.data.id,
      status: event.type === "session.tool.success" ? "succeeded" : "failed",
    };
  }
};

const describeWorkflowActivity = (activity: WorkflowActivity, stage: string): string => {
  const lastActivity = activity.lastActivity
    ? `${activity.lastActivity.type} at ${activity.lastActivity.at}${activity.lastActivity.seq === undefined ? "" : ` (seq ${activity.lastActivity.seq})`}`
    : `none observed during ${stage}`;
  const lastTool = activity.lastTool
    ? `; last tool ${activity.lastTool.name} (${activity.lastTool.id}, ${activity.lastTool.status})`
    : "";
  const model = activity.lastModel ? `; last model ${activity.lastModel}` : "";
  return `Model steps: ${activity.modelSteps}; completed tools: ${activity.completedTools}; last activity: ${lastActivity}${model}${lastTool}.`;
};

export const waitForIdle = async (
  host: EmbeddedHost,
  sessionId: string,
  options: {
    readonly timeoutMs: number;
    readonly configuredTimeoutMs?: number | undefined;
    readonly after?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly activity?: WorkflowActivity | undefined;
  },
): Promise<number> => {
  const controller = options.signal === undefined ? new AbortController() : undefined;
  const signal = options.signal ?? controller!.signal;
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    for await (const event of host.sessions.log(
      { sessionID: sessionId, follow: true, after: options.after },
      { signal },
    )) {
      if (options.activity !== undefined) recordWorkflowActivity(options.activity, event);
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
    if (controller?.signal.aborted) {
      throw new Error(
        `OpenCode session did not complete within ${options.configuredTimeoutMs ?? options.timeoutMs}ms.`,
        { cause },
      );
    }
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  throw new Error("OpenCode session log ended before the SEO agent completed.");
};

export const runWorkflowTurn = async (
  host: EmbeddedHost,
  sessionId: string,
  prompt: string,
  options: {
    readonly timeoutMs: number;
    readonly configuredTimeoutMs: number;
    readonly stage: string;
    readonly after?: number | undefined;
    readonly skills?: ReadonlyArray<string> | undefined;
    readonly activity: WorkflowActivity;
  },
): Promise<number> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let stage = options.stage;
  try {
    await host.sessions.prompt(
      {
        sessionID: sessionId,
        text: prompt,
        ...(options.skills === undefined ? {} : { skills: options.skills.map((id) => ({ id })) }),
      },
      { signal: controller.signal },
    );
    if (stage === "prompt admission") stage = "model execution";
    return await waitForIdle(host, sessionId, {
      timeoutMs: options.timeoutMs,
      configuredTimeoutMs: options.configuredTimeoutMs,
      after: options.after,
      signal: controller.signal,
      activity: options.activity,
    });
  } catch (cause) {
    if (!controller.signal.aborted) throw cause;
    let interruption = "unknown";
    try {
      interruption = (
        await host.sessions.interrupt({ sessionID: sessionId }, { signal: AbortSignal.timeout(5_000) })
      ).interrupted
        ? "active execution interrupted"
        : "no active execution to interrupt";
    } catch (interruptCause) {
      interruption = `interrupt request failed: ${interruptCause instanceof Error ? interruptCause.message : String(interruptCause)}`;
    }
    throw new Error(
      `OpenCode session did not complete within ${options.configuredTimeoutMs}ms during ${stage}; ${describeWorkflowActivity(options.activity, stage)} Timeout handling: ${interruption}.`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }
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
      const configuredTimeoutMs = options.timeoutMs ?? options.config.timeoutMs ?? 180_000;
      const deadline = Date.now() + configuredTimeoutMs;
      const remaining = (): number => Math.max(0, deadline - Date.now());
      const activity: WorkflowActivity = { modelSteps: 0, completedTools: 0, toolNames: new Map() };
      let cursor = await runWorkflowTurn(host, sessionId, prompt, {
        timeoutMs: remaining(),
        configuredTimeoutMs,
        stage: "prompt admission",
        after: cursors.get(sessionId),
        skills: workflowOptions.skills,
        activity,
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
          cursor = await runWorkflowTurn(host, sessionId, STATE_REPAIR_PROMPT, {
            timeoutMs: remaining(),
            configuredTimeoutMs,
            stage: "workflow state repair",
            after: cursor,
            activity,
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
            `The SEO agent returned without the required Executor evidence (searches: ${result.executor.searches.length}, calls: ${result.executor.calls.length}).`,
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
