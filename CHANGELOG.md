## pagegraph@0.8.3

### Attribute Executor evidence from structured search results

PageGraph now recognizes tool identifiers returned in Executor search-result `path` fields, including
JSON-encoded output, so valid provider calls satisfy the workflow evidence gate. Discovery stays
limited to those structured fields, preventing unrelated dotted metadata from authorizing a call.

## pagegraph@0.8.2

### Recover incomplete workflow results

When an OpenCode turn collects Executor evidence but omits its final workflow JSON, PageGraph now
runs one tool-free repair turn within the original deadline. Repair restores the session's prior
permissions, and deadline failures report the configured timeout instead of an opaque transport
error.

## pagegraph@0.8.1

### Wait for Executor activation

Workflow commands now wait for the configured Executor plugin to appear in OpenCode's plugin
registry before starting a run. Registry failures still propagate immediately, and a bounded timeout
keeps missing or misconfigured Executor installations fail-closed.

## pagegraph@0.8.0

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

## pagegraph@0.7.0

### Answer SEO decisions with Jev

Add a reusable decision runner and five typed decision families, answered in one
TypeSafe System One call per input. Confident answers produce a plan; answers
inside the confidence band go to a review queue. Nothing is applied automatically.

- `pagegraph decide serp` — classify the SERP format and score our page's fit,
  intent, and title (aligned | mismatch | review).
- `pagegraph decide content` — score the content rubric and place page value on
  thin | adequate | strong (pass | flag | review).
- `pagegraph decide fit` — choose the best existing page for a query, or flag
  cannibalization or a gap (map | cannibalized | gap | review).
- `pagegraph decide meta` — rank supplied title/description candidates
  (choose:<id> | review).
- `pagegraph decide authority` — judge a link target's legitimacy, spam, and
  outreach worth, plus its fit (accept | spam | review).
- `pagegraph decide links` (and the retained `links decide`) — real reason,
  anchor present, direction (A→B / B→A / both), and relevance, with top-K
  per-source budget selection.

Shared flags: `--model`, `--threshold`, `--concurrency`, `--cache`, `--review-out`,
and `--budget` for links. Every record carries the model id and an input hash.

## pagegraph@0.6.1

### Assert contextual coverage on the rendered graph

`pagegraph links verify` now closes the loop between declared and served links:

- `links verify <url> --emit-rendered <path>` writes the crawl's raw edge set as a
  versioned `links-rendered` artifact that preserves each anchor's `region`
  (`body` vs `nav`/`footer`/`header`) and the provenance a gate needs — `origin`,
  `seed`, the rendered page paths, and the crawl's `limit`, `truncated`,
  `bodyTruncated`, and `failures`. It is also a drop-in input for
  `links candidates --rendered`.
- `links verify --rendered <path>` replays a saved artifact instead of crawling, so
  one crawl can be asserted repeatedly without re-fetching.
- `links verify --assert-coverage` evaluates the `seo.config.ts` `coverage` rules
  against the anchors a crawler actually receives. Only same-origin body-region
  anchors count, matching `check`'s `related`-only semantics; the rule universe
  stays the declared graph's sitemap-eligible pages. An unmet rule exits 1, and the
  command refuses to assert — rather than reporting a false pass — on a truncated
  crawl, a page that failed to fetch, a truncated body, a missing `coverage`
  policy, or an origin mismatch.

The default `--json` summary is unchanged; the `coverage` block appears only under
`--assert-coverage`.

## pagegraph@0.6.0

### Verify and plan contextual links

Add `pagegraph links`, three commands over the link graph:

- `links verify <url>` crawls served HTML and reports homepage depth, rendered
  orphans, and the declared-vs-rendered gap. Anchor extraction honors `<base href>`,
  and the crawl dedupes redirect targets and surfaces truncated bodies.
- `links candidates` proposes reviewable, section-clustered contextual links from
  the declared graph, excluding anchors already rendered, with an optional
  `--decide` pass.
- `links decide` answers real-reason and anchor-present probabilities for a
  candidate set through TypeSafe System One (Jev), routing below-threshold
  answers to human review.

`pagegraph check` also gains `--require-inbound` (with a configurable policy) so a
sitemap-eligible page must have at least N incoming contextual edges.

## pagegraph@0.5.1

### Bundle Effect into the CLI

The published `pagegraph` binary now bundles `effect` and `@effect/platform-bun`. It no longer asks
consumers to install optional Effect peers, and no longer breaks when the consumer resolves a
different Effect RC — the `effect/unstable/cli` constructors rename between RCs (`Flag.boolean` →
`Flag.Boolean` at rc.113). The library entries remain Effect-free.

## pagegraph@0.5.0

### Compare timestamped SEO audits

Add `pagegraph diff <before.json> <after.json>` with deterministic human and JSON
output, schema validation, and regression-aware exit behavior. Structural
findings, scanner failures, and lost coverage fail the command, while editorial
changes and volatile scanner evidence remain non-blocking.

## pagegraph@0.4.1

### Default optional CLI switches

Treat omitted boolean switches as `false` so `pagegraph audit` and the shared `--json` option work without requiring unrelated flags.

## pagegraph@0.4.0

### Audit any website from the CLI

Add a framework-independent `pagegraph audit` command and public audit toolkit with composable Effect scanners, pure SEO rules, hardened network validation, Lighthouse evidence, and versioned human or JSON reports.

## pagegraph@0.3.0

### Compose any schema.org entity

Add custom site and page JSON-LD with typed helpers, stable entity references, graph composition,
and an optional transform for extending, replacing, suppressing, or expanding generated schemas.
Existing JSON-LD generators continue to work unchanged.

## pagegraph@0.2.1

### Add organization legal identity fields

Organization JSON-LD can now include a legal name and structured postal address, making business identity details easier for search engines and agents to understand.

## pagegraph@0.2.0

### Add Content-Signal to robots.txt

`renderRobots` now takes `contentSignal` (the preference list), extra `directives`, and a `transform` for a last-mile override. The same fields live on `seo.config.ts` so `pagegraph robots` prints the same file as the route. Preview hosts still omit the origin-wide group lines. No default signal.

## pagegraph@0.1.0

### Initial release

Route-declared SEO for TanStack Router: declare once on the route, then derive
the sitemap, robots.txt, breadcrumbs, JSON-LD, cross-link graph, Vite coverage
gate, and CLI from that graph.
