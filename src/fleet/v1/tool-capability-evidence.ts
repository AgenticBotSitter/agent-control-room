export type FleetToolCapabilityObservationV1 = Readonly<{
  tenantId: string;
  workerId: string;
  observedAt: string;
  phase: "enrollment" | "heartbeat";
  connectorVersion: string;
  platform: "macos" | "linux" | "windows" | "other";
  capabilities: readonly string[];
}>;

/** Evidence only: implementations may retain what the connector says is
 * installed, but this port never changes enrollment grants, claim scope, or
 * the authenticated worker principal. */
export type FleetToolCapabilityEvidencePortV1 = Readonly<{
  observe(observation: FleetToolCapabilityObservationV1): Promise<void>;
}>;

/** Deterministic non-database double for compositions and tests. */
export class InMemoryFleetToolCapabilityEvidenceV1 implements FleetToolCapabilityEvidencePortV1 {
  readonly #history: FleetToolCapabilityObservationV1[] = [];

  async observe(observation: FleetToolCapabilityObservationV1): Promise<void> {
    this.#history.push(Object.freeze({ ...observation,
      capabilities: Object.freeze([...observation.capabilities]) }));
  }

  history(): readonly FleetToolCapabilityObservationV1[] {
    return Object.freeze([...this.#history]);
  }

  latest(workerId: string): FleetToolCapabilityObservationV1 | undefined {
    return this.#history.findLast(observation => observation.workerId === workerId);
  }
}

export type FleetToolTaskInputV1 = Readonly<{ name: string; contentBase64: string }>;
export type FleetToolTaskBindingV1 = Readonly<{ tenantId: string; jobId: string; adapterId: string;
  inputs: Readonly<Record<string, FleetToolTaskInputV1>> }>;

/** Structured task-to-local-adapter binding. Implementations are populated by
 * the owner-approved task/input path; request text is deliberately absent. */
export type FleetToolTaskBindingPortV1 = Readonly<{
  read(tenantId: string, jobId: string): Promise<FleetToolTaskBindingV1 | undefined>;
}>;

export class InMemoryFleetToolTaskBindingsV1 implements FleetToolTaskBindingPortV1 {
  readonly #bindings = new Map<string, FleetToolTaskBindingV1>();

  constructor(bindings: readonly FleetToolTaskBindingV1[] = []) {
    for (const binding of bindings) this.put(binding);
  }

  put(binding: FleetToolTaskBindingV1): void {
    const inputs = Object.fromEntries(Object.entries(binding.inputs).map(([key, value]) =>
      [key, Object.freeze({ ...value })]));
    this.#bindings.set(`${binding.tenantId}\0${binding.jobId}`, Object.freeze({ ...binding, inputs: Object.freeze(inputs) }));
  }

  async read(tenantId: string, jobId: string): Promise<FleetToolTaskBindingV1 | undefined> {
    return this.#bindings.get(`${tenantId}\0${jobId}`);
  }
}
