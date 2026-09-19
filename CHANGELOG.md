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
