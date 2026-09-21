# Executor Starters for Keyword Research

These snippets are starting points, not an inventory. Search Executor in one Code Mode turn, retain
the exact returned paths, and call those paths in a later turn after resolving their current
signatures.

Discover Google Search Console or Bing query/page performance, OpenSEO cached project context and
keyword research, provider keyword metrics, and live SERP results. Prefer a relevant cached OpenSEO
result when it already covers the requested market, language, device, and freshness. When a matching
OpenSEO project can be resolved unambiguously, its project context and research log are supporting
evidence; the consumer repository remains authoritative for product truth.

~~~ts
return Promise.all([
  tools.executor.search({ query: "Google Search Console performance query page", limit: 8 }),
  tools.executor.search({ query: "OpenSEO project context cached keyword research", limit: 8 }),
  tools.executor.search({ query: "keyword volume difficulty current SERP results", limit: 8 }),
]);
~~~

In a later turn, replace placeholders with exact discovered paths:

~~~ts
const call = (path, input) => path.split(".").reduce((node, segment) => node[segment], tools)(input);
const owned = (await search({ query: "tools.<exact-owned-performance-path>", limit: 1 })).items[0];
const demand = (await search({ query: "tools.<exact-demand-path>", limit: 1 })).items[0];
return Promise.all([
  call(owned.path, { siteUrl, startDate, endDate, dimensions: ["PAGE", "QUERY"] }),
  call(demand.path, { keywords, market, language, device }),
]);
~~~

Treat Search Console and Bing as owned-site evidence, OpenSEO and DataForSEO as provider evidence,
and current result pages as observed evidence. Record market, language, device, reporting dates,
limits, task status, errors, and cost metadata when returned. Do not create or update an OpenSEO
project, save keywords, or perform another provider write.
