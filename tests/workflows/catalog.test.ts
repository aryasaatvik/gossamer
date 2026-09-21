import { describe, expect, it } from "vitest";

import { workflowCatalog, workflowIds } from "../../src/workflows/catalog";

describe("workflow catalog", () => {
  it("contains every approved workflow exactly once", () => {
    expect(workflowCatalog.size).toBe(workflowIds.length);
    expect([...workflowCatalog.keys()]).toEqual([...workflowIds]);
    for (const id of workflowIds) expect(workflowCatalog.get(id)?.id).toBe(id);
  });

  it("declares the skill and mutation boundary for each workflow", () => {
    const expected = {
      "research.keywords": { skills: ["keyword-research"], mutatesFiles: false },
      "research.competitors": { skills: ["competitive-landscape"], mutatesFiles: false },
      "research.authority": { skills: ["authority-research"], mutatesFiles: false },
      "analyze.serp": { skills: ["serp-analysis"], mutatesFiles: false },
      "analyze.content": { skills: ["content-analysis"], mutatesFiles: false },
      "analyze.ai-search": { skills: ["ai-search"], mutatesFiles: false },
      "plan.architecture": { skills: ["site-architecture"], mutatesFiles: false },
      "improve.content": { skills: ["content-improvement"], mutatesFiles: true },
      "improve.metadata": { skills: ["metadata-improvement"], mutatesFiles: true },
      "improve.schema": { skills: ["schema"], mutatesFiles: true },
      "improve.links": { skills: ["internal-linking"], mutatesFiles: true },
    } as const;

    for (const id of workflowIds) {
      const spec = workflowCatalog.get(id);
      expect(spec).toBeDefined();
      expect({
        skills: spec?.skills,
        mutatesFiles: spec?.mutatesFiles,
      }).toEqual(expected[id]);
      expect(spec?.researchInstructions.length).toBeGreaterThan(20);
      if (spec?.mutatesFiles) expect(spec.actionInstructions).toBeTruthy();
      else expect(spec?.actionInstructions).toBeUndefined();
    }
  });
});
