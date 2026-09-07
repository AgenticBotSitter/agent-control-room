import { isHostProxyV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { buildReadyFrontierFakeDeliveryAcknowledgementV1 } from "./no-relay";
import type { ReadyFrontierFakeDeliveryRequestV1 } from "./no-relay-types";
import { readyFrontierTimeSchemaV1 } from "./schemas";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }

const repositoryFakePorts = new WeakSet<object>();
const repositoryFakeDeliveryCounts = new WeakMap<object, number>();
const repositoryInterruptions = new WeakSet<object>();

/** A fixed in-memory fake with no callback, client, locator, credential, network, process, or filesystem seam. */
export class ReadyFrontierInMemoryFakeDeliveryV1 {
  readonly #outcome: "acknowledge" | "throw_after_marker" | "malformed" | "interrupt_after_marker";
  readonly #acknowledgedAt: string;

  constructor(outcome: "acknowledge" | "throw_after_marker" | "malformed" | "interrupt_after_marker",
    acknowledgedAt: string) {
    this.#acknowledgedAt = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, acknowledgedAt);
    this.#outcome = outcome; repositoryFakePorts.add(this);
    repositoryFakeDeliveryCounts.set(this, 0); Object.freeze(this);
  }

  async deliver(request: ReadyFrontierFakeDeliveryRequestV1): Promise<unknown> {
    repositoryFakeDeliveryCounts.set(this, (repositoryFakeDeliveryCounts.get(this) ?? 0) + 1);
    if (this.#outcome === "interrupt_after_marker") {
      const interruption = Object.freeze(Object.create(null)) as object;
      repositoryInterruptions.add(interruption); throw interruption;
    }
    if (this.#outcome === "throw_after_marker") throw new Error("repository fake delivery interruption");
    if (this.#outcome === "malformed") return Object.freeze({ schema: "invalid-repository-fake-result" });
    return buildReadyFrontierFakeDeliveryAcknowledgementV1({ runId: request.runId,
      deliveryId: request.deliveryId, jobId: request.jobId, routeId: request.routeId,
      handoffId: request.handoffId, acknowledgedAt: this.#acknowledgedAt,
      state: "acknowledged_repository_simulation", repositorySimulationOnly: true,
      createsAttempt: false, createsLease: false, claimsJob: false, dispatchesOrExecutes: false,
      contactsProvider: false, messagesAgent: false, mutatesGitHub: false, grantsExternalEffect: false });
  }

  deliveryCount(): number { return repositoryFakeDeliveryCounts.get(this) ?? 0; }
}

const repositoryFakeDeliver = ReadyFrontierInMemoryFakeDeliveryV1.prototype.deliver;
Object.freeze(ReadyFrontierInMemoryFakeDeliveryV1.prototype);

export interface ReadyFrontierBoundFakeDeliveryV1 {
  deliver(request: ReadyFrontierFakeDeliveryRequestV1): Promise<unknown>;
  isRepositoryInterruption(value: unknown): boolean;
}

/** Returns a closure over only the exact registered frozen fake and captured base implementation. */
export function bindReadyFrontierInMemoryFakeDeliveryV1(value: unknown): ReadyFrontierBoundFakeDeliveryV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !repositoryFakePorts.has(value)
    || Object.getPrototypeOf(value) !== ReadyFrontierInMemoryFakeDeliveryV1.prototype
    || !Object.isFrozen(value)) return undefined;
  const fake = value as ReadyFrontierInMemoryFakeDeliveryV1;
  return Object.freeze({
    deliver: (request: ReadyFrontierFakeDeliveryRequestV1) => repositoryFakeDeliver.call(fake, request),
    isRepositoryInterruption: (candidate: unknown) => !!candidate && typeof candidate === "object"
      && repositoryInterruptions.has(candidate),
  });
}

const repositoryClocks = new WeakSet<object>();

/** Fixed repository clock for deterministic AUTO-040 evidence; it is not a production clock. */
export class ReadyFrontierFixedRepositoryClockV1 {
  readonly #current: string;
  constructor(current: string) {
    this.#current = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, current);
    repositoryClocks.add(this); Object.freeze(this);
  }
  now(): string { return this.#current; }
}

const repositoryClockNow = ReadyFrontierFixedRepositoryClockV1.prototype.now;
Object.freeze(ReadyFrontierFixedRepositoryClockV1.prototype);

export function bindReadyFrontierFixedRepositoryClockV1(value: unknown): (() => string) | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !repositoryClocks.has(value)
    || Object.getPrototypeOf(value) !== ReadyFrontierFixedRepositoryClockV1.prototype
    || !Object.isFrozen(value)) return undefined;
  const clock = value as ReadyFrontierFixedRepositoryClockV1;
  return () => repositoryClockNow.call(clock);
}

export function parseReadyFrontierRepositoryClockV1(now: () => string): string {
  try { return parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, now()); }
  catch { fail("integrity_failed"); }
}
