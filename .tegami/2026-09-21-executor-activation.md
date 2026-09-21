---
packages:
  "pagegraph": patch
---

### Wait for Executor activation

Workflow commands now wait for the configured Executor plugin to appear in OpenCode's plugin
registry before starting a run. Registry failures still propagate immediately, and a bounded timeout
keeps missing or misconfigured Executor installations fail-closed.
