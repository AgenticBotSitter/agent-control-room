import { z } from "zod";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  type ControllerWorkerDeliveryV1, type ControllerWorkerRouteV1 } from "./controller-worker-delivery";
import { captureOwnerTrustedLocalEnablementV1, ownerTrustedLocalEnablementDigestV1, type OwnerTrustedLocalEnablementV1,
  type OwnerTrustedLocalWorkerKindV1 } from "./owner-trusted-local-enablements";
import { LOCAL_ADAPTER_IDS_V1 } from "./local-adapter-installation";

type Harness = keyof typeof LOCAL_ADAPTER_IDS_V1;
type Deliver = (delivery: ControllerWorkerDeliveryV1, route: ControllerWorkerRouteV1,
  receivedAt: string, signal?: AbortSignal) => Promise<unknown>;

function refused(): never { throw new Error("mac_local_adapter_registry_unavailable"); }
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

const kindForHarness: Readonly<Record<Harness, OwnerTrustedLocalWorkerKindV1>> = Object.freeze({
  codex: "codex", hermes: "hermes", claude: "claude-code",
});

/**
 * Installation-owned adapter bindings for one Mac.  This registry has no
 * scheduler, receipt store, retry policy, or process authority of its own.
 * Each callback is an already-composed harness delivery boundary, and must
 * independently re-check the canonical task immediately before its own
 * process boundary.  The registry only prevents an otherwise valid packet
 * from being redirected to a different enabled local executable.
 */
export type MacLocalAdapterRegistryV1 = Readonly<{
  enablement: OwnerTrustedLocalEnablementV1;
  /** The current host generation's status, derived after pinned executable
   * verification. This is checked immediately before the existing adapter
   * composition is called; it does not itself grant execution authority. */
  readiness: Readonly<{ isReady(workerId: string): boolean }>;
  adapters: Readonly<Partial<Record<Harness, Readonly<{
    workerId: string;
    adapterId: string;
    adapterRevision: string;
    deliver: Deliver;
  }>>>>;
}>;

function harnessFor(kind: OwnerTrustedLocalWorkerKindV1): Harness {
  if (kind === "codex") return "codex";
  if (kind === "hermes" || kind === "hermes-021") return "hermes";
  return "claude";
}

/** Capture a closed mapping from one pinned enablement record to the existing
 * per-harness delivery compositions.  No callback is run while capturing. */
export function captureMacLocalAdapterRegistryV1(value: MacLocalAdapterRegistryV1): MacLocalAdapterRegistryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || !Object.hasOwn(value, "enablement") || !Object.hasOwn(value, "readiness") || !Object.hasOwn(value, "adapters")
    || !value.adapters || typeof value.adapters !== "object" || Array.isArray(value.adapters)) refused();
  // A freshly loaded protected file has four fields; a previously captured
  // registry carries its verified digest as a fifth.  Validate either form
  // rather than treating a captured registry as a new trust assertion.
  const rawEnablement = value.enablement as unknown as Record<string, unknown>;
  const enablement = Object.hasOwn(rawEnablement, "enablementDigest")
    ? (() => { ownerTrustedLocalEnablementDigestV1(rawEnablement); return captureOwnerTrustedLocalEnablementV1({
      schema: rawEnablement.schema, mode: rawEnablement.mode, nodeId: rawEnablement.nodeId, workers: rawEnablement.workers,
    }); })()
    : captureOwnerTrustedLocalEnablementV1(rawEnablement);
  if (!value.readiness || typeof value.readiness.isReady !== "function") refused();
  const readiness = Object.freeze({ isReady: value.readiness.isReady.bind(value.readiness) });
  const adapters: Partial<Record<Harness, Readonly<{ workerId: string; adapterId: string; adapterRevision: string; deliver: Deliver }>>> = {};
  const enabled = new Map(enablement.workers.map(worker => [worker.kind, worker]));
  const keys = Object.keys(value.adapters);
  if (keys.length < 1 || keys.length > 3 || keys.some(key => !Object.hasOwn(LOCAL_ADAPTER_IDS_V1, key))) refused();
  for (const harness of keys as Harness[]) {
    const port = value.adapters[harness];
    if (!port || typeof port !== "object" || Array.isArray(port)
      || Object.keys(port).length !== 4 || ["workerId", "adapterId", "adapterRevision", "deliver"].some(key => !Object.hasOwn(port, key))
      || typeof port.workerId !== "string" || typeof port.adapterId !== "string" || typeof port.adapterRevision !== "string"
      || port.adapterRevision.length < 1 || port.adapterRevision.length > 180 || typeof port.deliver !== "function") refused();
    const expectedKind = kindForHarness[harness], worker = enabled.get(expectedKind);
    if (!worker || worker.workerId !== port.workerId || port.adapterId !== LOCAL_ADAPTER_IDS_V1[harness]) refused();
    Object.defineProperty(adapters, harness, { enumerable: true, value: Object.freeze({
      workerId: port.workerId, adapterId: port.adapterId, adapterRevision: port.adapterRevision,
      deliver: port.deliver.bind(port),
    }) });
  }
  return Object.freeze({ enablement, readiness, adapters: Object.freeze(adapters) });
}

/**
 * Calls exactly one installation-owned, already-composed local adapter.  A
 * controller route must be local and match the immutable worker, adapter, and
 * revision in the packet.  This deliberately never makes a retry decision or
 * manufactures a result: replay and recovery remain in the selected existing
 * harness composition and canonical queue lifecycle.
 */
export async function deliverMacLocalAdapterV1(registryValue: MacLocalAdapterRegistryV1,
  deliveryValue: unknown, routeValue: unknown, receivedAtValue: unknown, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) refused();
  const registry = captureMacLocalAdapterRegistryV1(registryValue);
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  const receivedAt = instant.parse(receivedAtValue);
  if (route.kind !== "local" || route.workerId !== delivery.worker.workerId) refused();
  const worker = registry.enablement.workers.find(value => value.workerId === route.workerId);
  if (!worker) refused();
  let ready: unknown;
  try { ready = registry.readiness.isReady(worker.workerId); } catch { return refused(); }
  if (ready !== true) refused();
  const harness = harnessFor(worker.kind), adapter = registry.adapters[harness];
  if (!adapter || adapter.workerId !== worker.workerId || adapter.adapterId !== delivery.worker.adapterId
    || adapter.adapterRevision !== delivery.worker.adapterRevision) refused();
  return adapter.deliver(delivery, route, receivedAt, signal);
}
