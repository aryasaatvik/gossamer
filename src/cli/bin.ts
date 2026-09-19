#!/usr/bin/env bun
/**
 * The `pagegraph` bin.
 *
 * Effect and `@effect/platform-bun` are bundled into this entry, so the published
 * binary is self-contained: it does not ask the consumer to install optional
 * Effect peers, and it does not couple to the consumer's Effect RC — the
 * `effect/unstable/cli` constructors rename between RCs (`Flag.boolean` →
 * `Flag.Boolean` at rc.113).
 *
 * The library entries (`.`, `./react`, `./vite`, `./config`) stay Effect-free, so a
 * consumer that only declares SEO on routes never installs Effect. `./audit` and
 * this CLI are where Effect is reached.
 */
import { run } from "./main";

run();

export {};
