import { z } from "zod";
import type { deliverHermes021MacosLocalTaskV1 } from "../hermes-021-v1/local-delivery-composition";
import type { deliverCodexLocalTaskV1 } from "../codex-v1/local-delivery-composition";
import type { deliverClaudeCodeLocalTaskV1 } from "../claude-code-v1/local-delivery-composition";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  controllerWorkerAdapterIdSchemaV1, type ControllerWorkerDeliveryV1, type ControllerWorkerRouteV1 } from "./controller-worker-delivery";
import { localId } from "./native-run-identifiers";
import { CODEX_APP_SERVER_ADAPTER } from "../codex-v1/delivery-contract";

export const LOCAL_ADAPTER_IDS_V1 = Object.freeze({
  hermes: "connector:hermes-021-macos-local-v1",
  codex: CODEX_APP_SERVER_ADAPTER,
  claude: "connector:claude-code-local-v1",
} as const);

type Results = {
  hermes: Awaited<ReturnType<typeof deliverHermes021MacosLocalTaskV1>>;
  codex: Awaited<ReturnType<typeof deliverCodexLocalTaskV1>>;
  claude: Awaited<ReturnType<typeof deliverClaudeCodeLocalTaskV1>>;
};

/** The installation binds each completed composition to its private config.
 * All adapters retain the one controller packet/route/time/signal input shape.
 * Their observations remain distinct: a Codex start is never a Claude session
 * or a Hermes terminal result, and none is canonical task completion. */
export type LocalAdapterInstallationPortsV1 = {
  [K in keyof Results]?: Readonly<{
    workerId: string;
    adapterId: typeof LOCAL_ADAPTER_IDS_V1[K];
    adapterRevision: string;
    state: "source_only";
    deliver(delivery: ControllerWorkerDeliveryV1, route: ControllerWorkerRouteV1,
      receivedAt: string, signal?: AbortSignal): Promise<Results[K]>;
  }>;
};

const unavailable = (): never => { throw new Error("local_adapter_installation_unavailable"); };
const identity = z.object({ workerId: localId, adapterId: controllerWorkerAdapterIdSchemaV1,
  adapterRevision: z.string().min(1).max(180), state: z.literal("source_only") }).strict();

/** Pure capture, not enablement. Deliberately accepts no proof flag: generic
 * topology readiness cannot substitute for exact harness qualification.
 * Production admission through this new seam remains unavailable pending a
 * separately reviewed binding to each harness's owner-operated proof gates.
 * Existing qualified Hermes composition is independent of this preparation. */
export function captureLocalAdapterInstallationPortsV1(input: LocalAdapterInstallationPortsV1): LocalAdapterInstallationPortsV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(LOCAL_ADAPTER_IDS_V1, key))) unavailable();
  const result: LocalAdapterInstallationPortsV1 = {};
  const workers = new Set<string>();
  for (const harness of Object.keys(LOCAL_ADAPTER_IDS_V1) as Array<keyof Results>) {
    const port = input[harness];
    if (port === undefined) continue;
    if (!port || Object.keys(port).some(key => !["workerId", "adapterId", "adapterRevision", "state", "deliver"].includes(key))) unavailable();
    const binding = identity.parse({ workerId: port.workerId, adapterId: port.adapterId,
      adapterRevision: port.adapterRevision, state: port.state });
    if (binding.adapterId !== LOCAL_ADAPTER_IDS_V1[harness] || workers.has(binding.workerId)
      || typeof port.deliver !== "function") unavailable();
    workers.add(binding.workerId);
    // Keep the original installation-owned callback and receiver, without
    // invoking it or allowing later replacement of the captured method.
    Object.defineProperty(result, harness, { enumerable: true, value: Object.freeze({
      ...binding, deliver: port.deliver.bind(port),
    }) });
  }
  return Object.freeze(result);
}

/** Admission boundary for the prepared ports. Even an exact match is refused
 * while source-only. This must never be used as a queue, retry or completion
 * service; it creates no receipt and never calls an adapter. */
export async function deliverPreparedLocalAdapterV1(ports: LocalAdapterInstallationPortsV1 | undefined,
  deliveryValue: unknown, routeValue: unknown, _receivedAt: string, _signal?: AbortSignal): Promise<never> {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  if (!ports || route.kind !== "local" || route.workerId !== delivery.worker.workerId) return unavailable();
  const captured = captureLocalAdapterInstallationPortsV1(ports);
  const match = Object.values(captured).find(port => port.workerId === route.workerId
    && port.adapterId === delivery.worker.adapterId && port.adapterRevision === delivery.worker.adapterRevision);
  if (!match) unavailable();
  return unavailable();
}
