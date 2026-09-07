import { sha256Digest } from "../../security/canonical-digest";
import { bindNativeStart, enrollmentSchema, nativeLimits, terminalNativeState, NativeJournalVersionConflict,
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
  private readonly observations = new Map<string, { cancel: AbortController; finished: Promise<void> }>();
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
  /** Rebase observations only, never an effect intent or a native request. Known version conflicts
   * may retry this local CAS three times; uncertain storage is not retried. Terminal evidence wins.
   */
  private reconcile(reference: NativeSnapshot,
    patch: (current: NativeSnapshot) => Partial<Omit<NativeSnapshot, "binding" | "version">>): NativeSnapshot {
    for (let tries = 0; tries < 3; tries++) {
      const current = this.load(reference.binding.runId);
      if (sha256Digest(current.binding) !== sha256Digest(reference.binding) || current.nativeRunId !== reference.nativeRunId) throw new Error("native_journal_binding_changed");
      if (terminalNativeState(current.state)) return current;
      try { return this.save(current, patch(current)); }
      catch (error) { if (!(error instanceof NativeJournalVersionConflict)) throw error; }
    }
    throw new NativeJournalVersionConflict();
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
  private async bounded<T>(deadline: number, work: (signal: AbortSignal) => Promise<T>, cancel?: AbortSignal): Promise<T> {
    const remaining = deadline - this.time();
    if (remaining <= 0) throw new Error("native_operation_expired");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(new Error("native_operation_cancelled")); };
        timer = setTimeout(abort, remaining); cancel?.addEventListener("abort", abort, { once: true });
        if (cancel?.aborted) abort();
      })]);
    } finally { if (timer) clearTimeout(timer); if (abort) cancel?.removeEventListener("abort", abort); controller.abort(); }
  }
  private deadline(operation: NativeOperation, binding: NativeBinding) {
    return Math.min(this.time() + (operation === "events" ? nativeLimits.streamMs : nativeLimits.requestMs),
      this.enrollment.validUntil, ...(["start", "capabilities", "events"].includes(operation) ? [binding.deadline] : []));
  }
  private async wire<T>(operation: NativeOperation, snapshot: NativeSnapshot,
    work: (request: NativeWireRequest) => Promise<T>, extra: Partial<NativeWireRequest> = {}, cancel?: AbortSignal) {
    const deadline = this.deadline(operation, snapshot.binding);
    return this.bounded(deadline, async signal => {
      await this.check(operation, snapshot.binding);
      if (signal.aborted || this.time() >= deadline) throw new Error("native_operation_expired");
      return work({ ...extra, operation, nativeRunId: snapshot.nativeRunId ?? undefined, deadline, signal,
        authorize: async () => {
          await this.check(operation, snapshot.binding);
          if (signal.aborted || this.time() >= deadline) throw new Error("native_operation_expired");
        } });
    }, cancel);
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
  private async resnapshot(snapshot: NativeSnapshot, cancel?: AbortSignal): Promise<NativeSnapshot> {
    if (terminalNativeState(snapshot.state) || !snapshot.nativeRunId) return snapshot;
    let response;
    try { response = await this.wire("status", snapshot, request => this.transport.json(request), {}, cancel); }
    catch { return cancel?.aborted ? this.load(snapshot.binding.runId)
      : this.reconcile(snapshot, () => ({ availability: this.time() >= this.enrollment.validUntil ? "expired" : "offline", safeReason: "transport_unavailable" })); }
    if (response.status === 404) return this.reconcile(snapshot, () => ({ state: "ambiguous", availability: "unknown", safeReason: "run_unavailable" }));
    let status: ReturnType<typeof readStatus>;
    try {
      status = readStatus(response, snapshot.nativeRunId, snapshot.binding);
    } catch { return this.reconcile(snapshot, () => ({ availability: "unknown", safeReason: "protocol_mismatch" })); }
    return this.reconcile(snapshot, current => {
      if (current.upstreamUpdatedAt !== null && status.upstreamUpdatedAt < current.upstreamUpdatedAt) return { availability: "unknown", safeReason: "protocol_mismatch" };
      // A stop acknowledgement is not undone by a queued/running snapshot racing with interruption.
      const state = current.state === "stopping" && !terminalNativeState(status.state) ? "stopping" : status.state;
      return { ...status, state, availability: "current", lastActivity: "status_resnapshot",
        safeReason: state === "interrupted" ? "gateway_interrupted" : "none" };
    });
  }
  private async observation(runId: string, work: (signal: AbortSignal) => Promise<NativeSnapshot>) {
    if (this.active.has(runId)) throw new Error("native_run_busy");
    const cancel = new AbortController(); let finished!: () => void;
    this.observations.set(runId, { cancel, finished: new Promise<void>(resolve => { finished = resolve; }) });
    try { return await this.exclusive(runId, () => work(cancel.signal)); }
    finally { this.observations.delete(runId); finished(); }
  }
  poll(runId: string) { return this.observation(runId, signal => this.resnapshot(this.load(runId), signal)); }
  async observe(runId: string): Promise<NativeSnapshot> {
    return this.observation(runId, async signal => {
      let snapshot = this.load(runId);
      if (terminalNativeState(snapshot.state) || !snapshot.nativeRunId) return snapshot;
      if (snapshot.streamAttempted) return this.resnapshot(snapshot, signal);
      // The pinned upstream removes its one-consumer queue on disconnect. A new stream is not replay.
      snapshot = this.save(snapshot, { streamAttempted: true });
      let receiving = true;
      const decoder = createNativeEventDecoder(snapshot.nativeRunId!, event => {
        if (receiving && !signal.aborted) snapshot = this.reconcile(snapshot, () => ({ lastActivity: event.kind }));
      });
      try {
        await this.wire("events", snapshot, request => this.transport.events(request, chunk => { if (receiving && !signal.aborted) decoder.push(chunk); }), {}, signal);
        decoder.finish();
      } catch { /* Even malformed/interrupted streams resnapshot the exact run; they never dispatch. */ }
      finally { receiving = false; }
      return signal.aborted ? this.load(runId) : this.resnapshot(snapshot, signal);
    });
  }
  async stop(runId: string): Promise<NativeSnapshot> {
    const observation = this.observations.get(runId);
    if (observation) { observation.cancel.abort(); await observation.finished; }
    return this.exclusive(runId, async () => {
      let snapshot = this.load(runId);
      if (terminalNativeState(snapshot.state) || !snapshot.nativeRunId) return snapshot;
      if (snapshot.stopAttempted) return this.resnapshot(snapshot);
      // Consumed before any HTTP call; an uncertain response is not permission to POST stop again.
      snapshot = this.save(snapshot, { stopAttempted: true });
      let stopped: ReturnType<typeof readStop>;
      try {
        const response = await this.wire("stop", snapshot, request => this.transport.json(request));
        stopped = readStop(response, snapshot.nativeRunId!, snapshot.binding);
      } catch { return this.reconcile(snapshot, () => ({ state: "ambiguous", availability: "unknown", safeReason: "transport_unavailable" })); }
      return this.reconcile(snapshot, current => {
        if ("upstreamUpdatedAt" in stopped && current.upstreamUpdatedAt !== null && stopped.upstreamUpdatedAt < current.upstreamUpdatedAt) return { availability: "unknown", safeReason: "protocol_mismatch" };
        return { ...stopped, availability: "current", safeReason: stopped.state === "interrupted" ? "gateway_interrupted" : "none" };
      });
    });
  }
}
