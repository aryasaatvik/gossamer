# Executor Starters for a Competitive Landscape

These snippets are starting points, not an inventory. Discover current tools and call only exact
returned paths after resolving their signatures.

~~~ts
return Promise.all([
  tools.executor.search({ query: "OpenSEO SERP competitors recurring domains", limit: 8 }),
  tools.executor.search({ query: "domain overview ranked keywords backlink authority", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const serp = (await search({ query: "tools.<exact-serp-path>", limit: 1 })).items[0];
return serp.path.split(".").reduce((node, segment) => node[segment], tools)({
  queries,
  market,
  language,
  device,
});
~~~

Prefer relevant cached OpenSEO context or research when an existing project matches the domain
unambiguously. Use external traffic and keyword values as estimates. Record query, market, device,
date, result depth, task status, errors, and cost. Do not update project context or competitors.
