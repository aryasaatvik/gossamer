import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type { Scanner } from "./scanner";

export interface ScannerRegistryShape {
  readonly all: () => readonly Scanner[];
  readonly get: (id: string) => Scanner | undefined;
}

/** Registry is deliberately a small service: callers depend on the protocol,
 * not on a concrete list of scanner implementations. */
export namespace ScannerRegistry {
  export class Service extends Context.Service<Service, ScannerRegistryShape>()(
    "gossamer/ScannerRegistry",
  ) {}
}

export const makeScannerRegistry = (
  scanners: Iterable<Scanner>,
): ScannerRegistryShape => {
  const values = [...scanners];
  const byId = new Map(values.map((value) => [value.id, value]));
  return {
    all: () => values,
    get: (id) => byId.get(id),
  };
};

export const ScannerRegistryLive = (
  scanners: Iterable<Scanner>,
): Layer.Layer<ScannerRegistry.Service> =>
  Layer.succeed(ScannerRegistry.Service, makeScannerRegistry(scanners));
