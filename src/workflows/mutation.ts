import { resolve } from "node:path";

/** The permission shape accepted by an OpenCode session. */
export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "ask" | "deny";
}

export interface WorkflowMutationPolicyOptions {
  /** The repository state captured immediately before the workflow starts. */
  readonly dirtyAtStart: boolean;
  /** Permit a mutating workflow to start with pre-existing local changes. */
  readonly allowDirty?: boolean | undefined;
  /** Run without repository mutation tools. Executor remains available. */
  readonly dryRun?: boolean | undefined;
  /** Absolute repository root used to scope file-edit permissions. */
  readonly root: string;
}

export interface WorkflowMutationPolicy {
  readonly mode: "write" | "dry-run";
  readonly dirtyAtStart: boolean;
  readonly allowDirty: boolean;
  /** Rules to pass to the OpenCode session when starting the workflow. */
  readonly sessionPermissions: ReadonlyArray<OpenCodePermissionRule>;
  readonly assertStartAllowed: () => void;
}

/**
 * OpenCode reports edit, write, and patch through the shared `edit` permission
 * family. Shell execution is denied as well because it could bypass that file
 * boundary. Executor tools use their own actions and remain available.
 */
const repositoryResource = (root: string): string => {
  const normalized = resolve(root).replaceAll("\\", "/");
  return `${normalized}/**`;
};

export const repositoryMutationPermissionRules = (
  root: string,
): ReadonlyArray<OpenCodePermissionRule> => [
  { action: "edit", resource: repositoryResource(root), effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
];

export const repositoryWritePermissionRules = (
  root: string,
): ReadonlyArray<OpenCodePermissionRule> => [
  { action: "edit", resource: repositoryResource(root), effect: "allow" },
  { action: "shell", resource: "*", effect: "deny" },
];

export const createWorkflowMutationPolicy = (
  options: WorkflowMutationPolicyOptions,
): WorkflowMutationPolicy => {
  const allowDirty = options.allowDirty === true;
  const dryRun = options.dryRun === true;
  const sessionPermissions = dryRun
    ? repositoryMutationPermissionRules(options.root)
    : repositoryWritePermissionRules(options.root);

  return {
    mode: dryRun ? "dry-run" : "write",
    dirtyAtStart: options.dirtyAtStart,
    allowDirty,
    sessionPermissions,
    assertStartAllowed: () => {
      if (options.dirtyAtStart && !allowDirty && !dryRun) {
        throw new Error(
          "Workflow refuses to run on a dirty Git tree; pass --allow-dirty for writes or --dry-run for read-only execution.",
        );
      }
    },
  };
};
