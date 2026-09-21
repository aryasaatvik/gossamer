# Executor Starters for Authority Research

These snippets are starting points, not an inventory. Discover backlink and live-page capabilities
before composing exact calls.

~~~ts
return Promise.all([
  tools.executor.search({ query: "OpenSEO DataForSEO backlink domain intersection", limit: 8 }),
  tools.executor.search({ query: "web search fetch directory editorial partner eligibility", limit: 8 }),
]);
~~~

In a later turn:

~~~ts
const gap = (await search({ query: "tools.<exact-backlink-gap-path>", limit: 1 })).items[0];
return gap.path.split(".").reduce((node, segment) => node[segment], tools)({
  targets: [ownedDomain, ...competitors],
  excludeInternal: true,
  limit: 100,
});
~~~

Record source URL, target domain, dates, limits, authority metrics, task status, errors, and cost.
Provider metrics nominate prospects; current pages determine legitimacy. Do not discover personal
contact data, send outreach, submit listings, or mutate OpenSEO project state.
