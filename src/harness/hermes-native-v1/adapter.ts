import { sha256Digest } from "../../security/canonical-digest";
import { bindNativeStart, enrollmentSchema, nativeLimits, terminalNativeState,
  type NativeAuthority, type NativeBinding, type NativeEnrollment, type NativeOperation, type NativeRunJournal,
  type NativeRunTransport, type NativeSnapshot, type NativeWireRequest } from "./contracts";
import { createNativeEventDecoder, readCapabilities, readStart, readStatus, readStop } from "./protocol";

/** Thin, unwired node-side adapter. The injected authority is the existing trusted admission/effect
 * controller, not a UI flag. Only that controller may authorize a qualified profile and exact task body.
 * A native terminal response is reported upstream state, never proof every OS descendant has exited.
 */
export class HermesNativeRunAdapter {
  private readonly enrollment: NativeEnrollment;
  private readonly active = new Set<string>();
  constructor(enrollment: NativeEnrollment, private readonly journal: NativeRunJournal,
    private readonly authority: NativeAuthority, private readonly transport: NativeRunTransport,
    private readonly now: () => number = Date.now) {
    this.enrollment = Object.freeze(enrollmentSchema.parse(enrollment));
  }
  private time(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("native_clock_invalid");
    return now;
  }
  private load(runId: string) {
    const snapshot = this.journal.load(runId);
    if (!snapshot || snapshot.binding.enrollmentDigest !== sha256Digest(this.enrollment)) throw new Error("native_run_not_available");
    return snapshot;
  }
  snapshot(runId: string): NativeSnapshot { return this.load(runId); }
  private save(snapshot: NativeSnapshot, patch: Partial<Omit<NativeSnapshot, "binding" | "version">>) {
    return this.journal.update(snapshot.binding.runId, snapshot.version, { ...patch, observedAt: this.time() });
  }
  private async exclusive(runId: string, work: () => Promise<NativeSnapshot>) {
    if (this.active.has(runId)) throw new Error("native_run_busy");
    this.active.add(runId);
    try { return await work(); } finally { this.active.delete(runId); }
  }
  private async check(operation: NativeOperation, binding: NativeBinding) {
    const now = this.time();
    if (now >= this.enrollment.validUntil || ((operation === "start" || operation === "capabilities" || operation === "events") && now >= binding.deadline)) {
      throw new Error("native_authority_expired");
    }
    // Status/stop after the task deadline require separate current observation/cleanup authority.
    await this.authority.check(operation, binding);
    if (this.time() >= this.enrollment.validUntil || ((operation === "start" || operation === "capabilities" || operation === "events") && this.time() >= binding.deadline)) {
      throw new Error("native_authority_expired");
    }
  }
  private async bounded<T>(deadline: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const remaining = deadline - this.time();
    if (remaining <= 0) throw new Error("native_operation_expired");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("native_operation_timeout")); }, remaining);
      })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private deadline(operation: NativeOperation, binding: NativeBinding) {
    return Math.min(this.time() + (operation === "events" ? nativeLimits.streamMs : nativeLimits.requestMs),
      this.enrollment.validUntil, ...(["start", "capabilities", "events"].includes(operation) ? [binding.deadline] : []));
  }
  private async wire<T>(operation: NativeOperation, snapshot: NativeSnapshot,
    work: (request: NativeWireRequest) => Promise<T>, extra: Partial<NativeWireRequest> = {}) {
    const deadline = this.deadline(operation, snapshot.binding);
    return this.bounded(deadline, async signal => {
      await this.check(operation, snapshot.binding);
      if (signal.aborted || this.time() >= deadline) throw new Error("native_operation_expired");
      return work({ ...extra, operation, nativeRunId: snapshot.nativeRunId ?? undefined, deadline, signal,
        authorize: async () => {
          await this.check(operation, snapshot.binding);
          if (signal.aborted || this.time() >= deadline) throw new Error("native_operation_expired");
        } });
    });
  }
  async start(value: unknown): Promise<NativeSnapshot> {
    let bound: ReturnType<typeof bindNativeStart>;
    try { bound = bindNativeStart(this.enrollment, value); } catch { throw new Error("native_start_invalid"); }
    return this.exclusive(bound.binding.runId, async () => {
      const reserved = this.journal.reserve(bound.binding, this.time());
      // Even a prepared record could precede a crash. Never replay it automatically.
      if (!reserved.created) return reserved.snapshot;
      let snapshot = reserved.snapshot;
      try {
        const capabilities = await this.wire("capabilities", snapshot, request => this.transport.json(request));
        readCapabilities(capabilities, Math.max(1, Math.ceil((bound.binding.deadline - this.time()) / 1000)));
      } catch { return this.save(snapshot, { state: "failed", availability: "offline", safeReason: "preflight_failed" }); }
      // Persist dispatch intent first: an uncertain marker/POST can only enter reconciliation, not retry.
      snapshot = this.save(snapshot, { state: "dispatching" });
      try {
        await this.bounded(this.deadline("start", snapshot.binding), async signal => {
          await this.check("start", snapshot.binding);
          if (signal.aborted) throw new Error("native_operation_expired");
          await this.authority.markStart(snapshot.binding);
        });
        const response = await this.wire("start", snapshot, request => this.transport.json(request), {
          body: bound.body, idempotencyKey: bound.binding.effectClaimKey, sessionKey: bound.binding.sessionId,
        });
        const nativeRunId = readStart(response);
        snapshot = this.save(snapshot, { state: "queued", nativeRunId, availability: "current", safeReason: "none" });
        return snapshot;
      } catch {
        // A storage failure may quarantine the journal; do not manufacture an unsaved outcome.
        return this.save(snapshot, { state: "ambiguous", availability: "unknown", safeReason: "dispatch_uncertain" });
      }
    });
  }
  private async resnapshot(snapshot: NativeSnapshot): Promise<NativeSnapshot> {
    if (terminalNativeState(snapshot.state) || !snapshot.nativeRunId) return snapshot;
    let response;
    try { response = await this.wire("status", snapshot, request => this.transport.json(request)); }
    catch { return this.save(snapshot, { availability: this.time() >= this.enrollment.validUntil ? "expired" : "offline", safeReason: "transport_unavailable" }); }
    if (response.status === 404) return this.save(snapshot, { state: "ambiguous", availability: "unknown", safeReason: "run_unavailable" });
    try {
      const status = readStatus(response, snapshot.nativeRunId, snapshot.binding);
      if (snapshot.upstreamUpdatedAt !== null && status.upstreamUpdatedAt < snapshot.upstreamUpdatedAt) throw new Error("native_status_regression");
      // A stop acknowledgement is not undone by a queued/running snapshot racing with interruption.
      if (snapshot.state === "stopping" && !terminalNativeState(status.state)) status.state = "stopping";
      return this.save(snapshot, { ...status, availability: "current", lastActivity: "status_resnapshot",
        safeReason: status.state === "interrupted" ? "gateway_interrupted" : "none" });
    } catch { return this.save(snapshot, { availability: "unknown", safeReason: "protocol_mismatch" }); }
  }
  poll(runId: string) { return this.exclusive(runId, () => this.resnapshot(this.load(runId))); }
  async observe(runId: string): Promise<NativeSnapshot> {
    return this.exclusive(runId, async () => {
      let snapshot = this.load(runId);
      if (terminalNativeState(snapshot.state) || !snapshot.nativeRunId) return snapshot;
      if (snapshot.streamAttempted) return this.resnapshot(snapshot);
      // The pinned upstream removes its one-consumer queue on disconnect. A new stream is not replay.
      snapshot = this.save(snapshot, { streamAttempted: true });
      let receiving = true;
      const decoder = createNativeEventDecoder(snapshot.nativeRunId!, event => {
        if (receiving) snapshot = this.save(snapshot, { lastActivity: event.kind });
      });
      try {
        await this.wire("events", snapshot, request => this.transport.events(request, chunk => { if (receiving) decoder.push(chunk); }));
        decoder.finish();
      } catch { /* Even malformed/interrupted streams resnapshot the exact run; they never dispatch. */ }
      finally { receiving = false; }
      return this.resnapshot(snapshot);
    });
  }
  async stop(runId: string): Promise<NativeSnapshot> {
    return this.exclusive(runId, async () => {
      let snapshot = this.load(runId);
      if (terminalNativeState(snapshot.state) || !snapshot.nativeRunId) return snapshot;
      if (snapshot.stopAttempted) return this.resnapshot(snapshot);
      // Consumed before any HTTP call; an uncertain response is not permission to POST stop again.
      snapshot = this.save(snapshot, { stopAttempted: true });
      try {
        const response = await this.wire("stop", snapshot, request => this.transport.json(request));
        const stopped = readStop(response, snapshot.nativeRunId!, snapshot.binding);
        if ("upstreamUpdatedAt" in stopped && snapshot.upstreamUpdatedAt !== null && stopped.upstreamUpdatedAt < snapshot.upstreamUpdatedAt) throw new Error("native_status_regression");
        return this.save(snapshot, { ...stopped, availability: "current", safeReason: stopped.state === "interrupted" ? "gateway_interrupted" : "none" });
      } catch { return this.save(snapshot, { state: "ambiguous", availability: "unknown", safeReason: "transport_unavailable" }); }
    });
  }
}
