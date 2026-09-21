Continue PageGraph's {{workflow}} workflow.

{{instructions}}

Observed state:
{{state}}

Jev decisions:
{{decisions}}

Apply only records in the resolved set whose verdict calls for a change. Never apply review records;
leave them in the artifact for a human. If nothing is safely resolved, return no-change.

Repository mutation mode: {{mutationMode}}. {{mutationInstruction}}

Return only one JSON object with this shape:
{"summary":"...","files":["relative/path"],"outcome":"applied|dry-run|no-change"}
