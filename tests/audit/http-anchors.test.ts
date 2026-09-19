import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeHttp } from "../../src/audit/scanners/http";
import type { ProbeRequest } from "../../src/audit/model";

let server: Server;
let target: URL;

const html = `<!doctype html><html><body>
  <nav><a href="/nav">Nav</a></nav>
  <main><a href="/body">Body</a></main>
  <footer><a href="https://external.test/x">External</a></footer>
</body></html>`;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture did not bind");
  target = new URL(`http://127.0.0.1:${address.port}/`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const options = {
  allowPrivate: true,
  timeoutMs: 5_000,
  maxBodyBytes: 1_000_000,
};

const request = (): ProbeRequest => ({
  kind: "page-html",
  method: "GET",
  accept: "text/html, */*;q=0.1",
  url: target,
});

describe("probeHttp anchor capture", () => {
  it("omits anchors unless the caller opts in", async () => {
    const probe = await probeHttp(request(), options);
    expect(probe.anchors).toBeUndefined();
  });

  it("exposes resolved anchors with their regions when opted in", async () => {
    const probe = await probeHttp(request(), { ...options, captureAnchors: true });
    expect(probe.anchors?.map((anchor) => `${anchor.region}:${anchor.href}`)).toEqual([
      `nav:${target.origin}/nav`,
      `body:${target.origin}/body`,
      `footer:https://external.test/x`,
    ]);
    expect(probe.anchors?.map((anchor) => anchor.internal)).toEqual([true, true, false]);
  });
});
