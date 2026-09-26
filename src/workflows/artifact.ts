import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { WorkflowResearchCheckpointV1, WorkflowRunV1 } from "./model";
import summaryTemplate from "./prompts/summary.md" with { type: "text" };
import { TextTemplate } from "./template";

export const createRunId = (
  date = new Date(),
  workflow = "workflow",
  nonce = randomUUID(),
): string =>
  `${date.toISOString().replaceAll(":", "-").replace(".", "-")}-${nonce.slice(0, 8)}-${workflow.replaceAll(".", "-")}`;

const resultSummary = (result: unknown): string => {
  if (result !== null && typeof result === "object") {
    const summary = (result as Record<string, unknown>)["summary"];
    if (typeof summary === "string") return summary;
  }
  return "Workflow completed; inspect run.json for the structured result.";
};

const summary = (run: WorkflowRunV1): string => {
  const counts = run.decisions[0]?.report.counts;
  return TextTemplate.from(summaryTemplate)
    .values({
      workflow: run.workflow,
      runId: run.id,
      model: `${run.model.provider}/${run.model.id}`,
      pages: run.targets.pages.length,
      decisions: counts?.inputs ?? 0,
      review: counts?.review ?? 0,
      executorSearches: run.evidence.executor.searches.length,
      executorCalls: run.evidence.executor.calls.length,
      changedFiles: run.changes.files.length,
      summary: resultSummary(run.result),
    })
    .render();
};

export const writeRunBundle = (
  root: string,
  runsDirectory: string,
  run: WorkflowRunV1,
): string => {
  const directory = resolve(root, runsDirectory, run.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(resolve(directory, "summary.md"), summary(run), "utf8");
  return directory;
};

export const writeResearchCheckpoint = (
  root: string,
  runsDirectory: string,
  checkpoint: WorkflowResearchCheckpointV1,
): string => {
  const directory = resolve(root, runsDirectory, checkpoint.id);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "research.json");
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  return path;
};

export const writeResearchFailure = (
  root: string,
  runsDirectory: string,
  id: string,
  details: unknown,
): string => {
  const directory = resolve(root, runsDirectory, id);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "research-failure.json");
  writeFileSync(path, `${JSON.stringify(details, null, 2)}\n`, "utf8");
  return path;
};
