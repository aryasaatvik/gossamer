import presetAgents from "./AGENTS.md" with { type: "text" };
import presetSeoAgent from "./agents/seo.md" with { type: "text" };
import presetOpenCode from "./opencode.jsonc" with { type: "text" };
import aiSearchSkill from "./skills/ai-search/SKILL.md" with { type: "text" };
import aiSearchExecutor from "./skills/ai-search/references/executor.md" with { type: "text" };
import authorityResearchSkill from "./skills/authority-research/SKILL.md" with { type: "text" };
import authorityResearchExecutor from "./skills/authority-research/references/executor.md" with { type: "text" };
import competitiveLandscapeSkill from "./skills/competitive-landscape/SKILL.md" with { type: "text" };
import competitiveLandscapeExecutor from "./skills/competitive-landscape/references/executor.md" with { type: "text" };
import contentAnalysisSkill from "./skills/content-analysis/SKILL.md" with { type: "text" };
import contentAnalysisExecutor from "./skills/content-analysis/references/executor.md" with { type: "text" };
import contentImprovementSkill from "./skills/content-improvement/SKILL.md" with { type: "text" };
import contentImprovementExecutor from "./skills/content-improvement/references/executor.md" with { type: "text" };
import internalLinkingSkill from "./skills/internal-linking/SKILL.md" with { type: "text" };
import internalLinkingExecutor from "./skills/internal-linking/references/executor.md" with { type: "text" };
import keywordResearchSkill from "./skills/keyword-research/SKILL.md" with { type: "text" };
import keywordResearchExecutor from "./skills/keyword-research/references/executor.md" with { type: "text" };
import metadataImprovementSkill from "./skills/metadata-improvement/SKILL.md" with { type: "text" };
import metadataImprovementExecutor from "./skills/metadata-improvement/references/executor.md" with { type: "text" };
import schemaSkill from "./skills/schema/SKILL.md" with { type: "text" };
import schemaExecutor from "./skills/schema/references/executor.md" with { type: "text" };
import serpAnalysisSkill from "./skills/serp-analysis/SKILL.md" with { type: "text" };
import serpAnalysisExecutor from "./skills/serp-analysis/references/executor.md" with { type: "text" };
import siteArchitectureSkill from "./skills/site-architecture/SKILL.md" with { type: "text" };
import siteArchitectureExecutor from "./skills/site-architecture/references/executor.md" with { type: "text" };

const skill = (
  name: string,
  definition: string,
  executor: string,
): Readonly<Record<string, string>> => ({
  [`.pagegraph/opencode/skills/${name}/SKILL.md`]: definition,
  [`.pagegraph/opencode/skills/${name}/references/executor.md`]: executor,
});

export const opencodePreset: Readonly<Record<string, string>> = {
  ".pagegraph/opencode/opencode.jsonc": presetOpenCode,
  ".pagegraph/opencode/AGENTS.md": presetAgents,
  ".pagegraph/opencode/agents/seo.md": presetSeoAgent,
  ...skill("keyword-research", keywordResearchSkill, keywordResearchExecutor),
  ...skill("competitive-landscape", competitiveLandscapeSkill, competitiveLandscapeExecutor),
  ...skill("authority-research", authorityResearchSkill, authorityResearchExecutor),
  ...skill("serp-analysis", serpAnalysisSkill, serpAnalysisExecutor),
  ...skill("content-analysis", contentAnalysisSkill, contentAnalysisExecutor),
  ...skill("ai-search", aiSearchSkill, aiSearchExecutor),
  ...skill("site-architecture", siteArchitectureSkill, siteArchitectureExecutor),
  ...skill("content-improvement", contentImprovementSkill, contentImprovementExecutor),
  ...skill("metadata-improvement", metadataImprovementSkill, metadataImprovementExecutor),
  ...skill("schema", schemaSkill, schemaExecutor),
  ...skill("internal-linking", internalLinkingSkill, internalLinkingExecutor),
};
