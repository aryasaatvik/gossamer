# Executor Starters for AI Search Analysis

These snippets are starting points, not an inventory. Search for current citation, brand-mention,
answer-engine, and owned-performance capabilities available through Executor.

~~~ts
return Promise.all([
  tools.executor.search({ query: "AI search citations answer visibility brand mentions", limit: 8 }),
  tools.executor.search({ query: "Google Search Console generative AI performance page", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const visibility = (await search({ query: "tools.<exact-ai-visibility-path>", limit: 1 })).items[0];
return visibility.path.split(".").reduce((node, segment) => node[segment], tools)({
  domain,
  queries,
  market,
  language,
});
~~~

Record engine or surface, query, market, collection date, cited URL, response excerpt, sampling
method, task status, errors, and cost. Missing citations in a small sample do not prove absence.
Do not mutate provider projects or publish content.
