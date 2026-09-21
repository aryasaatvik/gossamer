---
packages:
  "pagegraph": patch
---

### Recover incomplete workflow results

When an OpenCode turn collects Executor evidence but omits its final workflow JSON, PageGraph now
runs one tool-free repair turn within the original deadline. Repair restores the session's prior
permissions, and deadline failures report the configured timeout instead of an opaque transport
error.
