# Executor Starters for Metadata Improvement

These snippets are starting points, not an inventory. Discover owned query/page evidence and a
current SERP before selecting a candidate.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Google Search Console query page CTR position", limit: 8 }),
  tools.executor.search({ query: "current SERP titles snippets intent", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const owned = (await search({ query: "tools.<exact-owned-performance-path>", limit: 1 })).items[0];
return owned.path.split(".").reduce((node, segment) => node[segment], tools)({
  siteUrl,
  startDate,
  endDate,
  dimensions: ["PAGE", "QUERY"],
});
~~~

Record dates, query and page filters, market, device, task status, errors, and cost. CTR and position
describe observed performance; they do not prove a particular title caused it. Do not mutate
provider metadata or request recrawls.
