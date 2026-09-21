---
packages:
  "pagegraph": minor
---

### Run page-backed SEO workflows

Combine PageGraph's deterministic route graph with an embedded OpenCode agent, project-owned
configuration, live Executor tools, and Jev decisions. The new workflow-oriented CLI covers keyword,
competitor, and authority research; SERP, content, and AI-search analysis; architecture planning; and
content, metadata, schema, and internal-link improvements.

- `pagegraph init` scaffolds a customizable `.pagegraph/opencode` preset with one SEO agent,
  workflow-specific skills, and editable Executor starter recipes.
- `research`, `analyze`, and `plan` workflows collect evidence without changing project files.
- `improve` workflows require a clean Git tree, support `--dry-run`, leave edits uncommitted, and
  record the resulting file changes.
- Every run persists its graph, project context, OpenCode session, live-tool evidence, Jev answers,
  Git provenance, and model provenance under `.pagegraph/runs`.

This release replaces the low-level public decision commands and input-oriented exports with the
smaller workflow surface. OpenCode owns model authentication and configuration; an Executor plugin
provides live SEO integrations discovered at runtime.
