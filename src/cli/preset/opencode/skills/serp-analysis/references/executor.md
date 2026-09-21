# Executor Starters for SERP Analysis

These snippets are starting points, not an inventory. Discover a current organic SERP capability
and resolve its exact signature before use.

~~~ts
return tools.executor.search({
  query: "OpenSEO DataForSEO current organic SERP features intent",
  limit: 8,
});
~~~

In a later turn:

~~~ts
const serp = (await search({ query: "tools.<exact-serp-path>", limit: 1 })).items[0];
return serp.path.split(".").reduce((node, segment) => node[segment], tools)({
  query,
  market,
  language,
  device,
  depth: 20,
});
~~~

Reuse a matching cached OpenSEO SERP when it satisfies the requested freshness. Record query,
market, language, device, collection time, depth, features, task status, errors, and cost. Fetch
individual result pages only when their content is material to the decision.
