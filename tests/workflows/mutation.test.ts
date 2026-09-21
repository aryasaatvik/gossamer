import { describe, expect, it } from "vitest";

import {
  createWorkflowMutationPolicy,
  repositoryMutationPermissionRules,
  repositoryWritePermissionRules,
} from "../../src/workflows/mutation";

describe("workflow mutation policy", () => {
  it("allows clean workflows to write by default", () => {
    const policy = createWorkflowMutationPolicy({
      root: "/tmp/pagegraph-project",
      dirtyAtStart: false,
    });

    expect(policy.mode).toBe("write");
    expect(policy.sessionPermissions).toEqual(repositoryWritePermissionRules("/tmp/pagegraph-project"));
    expect(() => policy.assertStartAllowed()).not.toThrow();
  });

  it("refuses dirty mutating workflows unless explicitly allowed", () => {
    const policy = createWorkflowMutationPolicy({
      root: "/tmp/pagegraph-project",
      dirtyAtStart: true,
    });

    expect(() => policy.assertStartAllowed()).toThrow(/dirty Git tree/);
  });

  it("allows an explicitly dirty mutating workflow", () => {
    const policy = createWorkflowMutationPolicy({
      root: "/tmp/pagegraph-project",
      dirtyAtStart: true,
      allowDirty: true,
    });

    expect(policy.mode).toBe("write");
    expect(() => policy.assertStartAllowed()).not.toThrow();
  });

  it("allows dirty dry runs and denies repository edit tools only", () => {
    const rules = repositoryMutationPermissionRules("/tmp/pagegraph-project");
    const policy = createWorkflowMutationPolicy({
      root: "/tmp/pagegraph-project",
      dirtyAtStart: true,
      dryRun: true,
    });

    expect(policy.mode).toBe("dry-run");
    expect(() => policy.assertStartAllowed()).not.toThrow();
    expect(rules).toEqual([
      { action: "edit", resource: "/tmp/pagegraph-project/**", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
    expect(rules.some((rule) => rule.action === "*" || rule.action.startsWith("executor"))).toBe(
      false,
    );
    expect(policy.sessionPermissions).toEqual(rules);
  });
});
