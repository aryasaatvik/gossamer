import type * as AiError from "effect/unstable/ai/AiError";
import type { DecisionModel } from "effect/unstable/ai";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DecisionBatchReport } from "../../decide/record";
import { runDecisions, type DecisionFamily } from "../../decide/run";
import type { WorkflowId } from "../model";

export const WORKFLOW_SKILLS = ["content", "technical", "authority"] as const;
export type WorkflowSkill = (typeof WORKFLOW_SKILLS)[number];

export interface WorkflowSpecDefinition<State, Input> {
  readonly id: WorkflowId;
  readonly skills: ReadonlyArray<WorkflowSkill>;
  readonly mutatesFiles: boolean;
  readonly stateSchema: Schema.ConstraintDecoder<State>;
  readonly decisionInputs: (state: State) => ReadonlyArray<Input>;
  readonly family: DecisionFamily<Input>;
  readonly researchInstructions: string;
  readonly actionInstructions?: string | undefined;
}

export interface WorkflowDecisionQuestion {
  readonly inputRef: string;
  readonly decisions: Readonly<Record<string, unknown>>;
}

/**
 * Runtime workflow contract. `defineWorkflow` closes over each workflow's
 * concrete state and decision-input types, so the catalog can stay
 * heterogeneous without leaking `any` or unchecked casts into the runner.
 */
export interface AnyWorkflowSpec {
  readonly id: WorkflowId;
  readonly skills: ReadonlyArray<WorkflowSkill>;
  readonly mutatesFiles: boolean;
  readonly stateJsonSchema: unknown;
  readonly familyName: string;
  readonly researchInstructions: string;
  readonly actionInstructions?: string | undefined;
  readonly decodeState: (value: unknown) => unknown;
  readonly decisionInputs: (state: unknown) => ReadonlyArray<unknown>;
  readonly validateDecisionInput: (input: unknown) => string | undefined;
  readonly decisionQuestions: (
    inputs: ReadonlyArray<unknown>,
  ) => ReadonlyArray<WorkflowDecisionQuestion>;
  readonly runDecisions: (options: {
    readonly inputs: ReadonlyArray<unknown>;
    readonly model: string;
    readonly threshold: number;
  }) => Effect.Effect<DecisionBatchReport, AiError.AiError, DecisionModel.DecisionModel>;
}

export const defineWorkflow = <State, Input>(
  definition: WorkflowSpecDefinition<State, Input>,
): AnyWorkflowSpec => {
  const decodeState = Schema.decodeUnknownSync(definition.stateSchema);
  const decodeInput = Schema.decodeUnknownSync(definition.family.input);
  const inputsFrom = (state: unknown): ReadonlyArray<Input> =>
    definition.decisionInputs(decodeState(state));
  const decodedInputs = (inputs: ReadonlyArray<unknown>): ReadonlyArray<Input> =>
    inputs.map((input) => decodeInput(input));

  const DecisionMetadataSchema = Schema.Struct({
    _tag: Schema.String,
    instructions: Schema.String,
    criteria: Schema.Unknown,
  });
  const decodeDecisionMetadata = Schema.decodeUnknownSync(DecisionMetadataSchema);

  return {
    id: definition.id,
    skills: definition.skills,
    mutatesFiles: definition.mutatesFiles,
    stateJsonSchema: Schema.toJsonSchemaDocument(definition.stateSchema),
    familyName: definition.family.name,
    researchInstructions: definition.researchInstructions,
    actionInstructions: definition.actionInstructions,
    decodeState,
    decisionInputs: inputsFrom,
    validateDecisionInput: (input) => definition.family.validate?.(decodeInput(input)),
    decisionQuestions: (inputs) =>
      decodedInputs(inputs).map((input) => {
        const decision = definition.family.definitionFor(input);
        return {
          inputRef: definition.family.inputRef(input),
          decisions: Object.fromEntries(
            Object.entries(decision.decisions).map(([name, raw]) => {
              const item = decodeDecisionMetadata(raw);
              return [
                name,
                {
                  kind: item._tag,
                  instructions: item.instructions,
                  criteria: item.criteria,
                },
              ];
            }),
          ),
        };
      }),
    runDecisions: ({ inputs, model, threshold }) =>
      runDecisions({
        family: definition.family,
        inputs: decodedInputs(inputs),
        model,
        threshold,
      }),
  };
};

export const stateWith = <Item>(item: Schema.ConstraintDecoder<Item>) =>
  Schema.Struct({
    summary: Schema.String,
    items: Schema.Array(item),
  });
