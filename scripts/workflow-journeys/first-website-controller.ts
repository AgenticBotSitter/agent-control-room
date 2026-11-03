import { loopAdapterUnavailableDetailV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
// Proof-only foreground controller. Imports are inert. Engine commands go
// through the product website; role input binding uses the qualified A2 entry.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  b5JourneySchemaV1, finalizeFirstWebsiteEvidenceV1, missingB5TransportCleanupV1, B5RefusalV1, B5_MAX_DURATION_MS, B5_REQUEST_TEXT, b5Bytes, type B5VerdictV1, type FirstWebsiteCleanupOwnerV1,
  loadFirstWebsiteAssemblyV1, probeBindInputCapabilityV1, bindFirstWebsiteInputsV1, assertRoleScopedBriefsV1,
  b5FaultScanPolicySchemaV1, normalizeB5FaultTextV1, assertB5FaultTextAbsentV1, assertB5FaultValueAbsentV1, auditFirstWebsiteReviewV1, readB5ReviewGitSurfacesV1,
  readFirstWebsitePrivateBytesV1, runIndependentStatusCheckV1, verifyFirstWebsiteEvidenceV1, readB5CandidateResponseV1, assertFirstWebsiteOwnerCommandV1,
  qualifyB5RealEvidenceV1, type B5QualifiedPinsV1,
  type FirstWebsitePreflightV1, type FirstWebsiteHostV1,
} from "../../tests/helpers/improve-control-room-first-website";
import {
  redactB5EvidenceV1, retainB5TransportQualificationV1, assertB5EvidenceSecretFreeV1, b5DeviceServiceEvidenceSchemaV1, b5DeviceReceiptSchemaV1, B5DeviceRefusalV1, createB5DeviceCleanupV1, type B5TransportQualificationV1,
  loadB5TransportV1, waitB5DeviceJsonV1, writeB5DeviceRequestV1,
  B5_DEVICE_INSTALL_COMMAND_V1, B5_DEVICE_OFF_COMMAND_V1, B5_DEVICE_STATUS_COMMAND_V1, b5MappingDigestV1,
  type B5DeviceRequestV1, type B5DeviceMailboxV1,
} from "./first-website-device";

import { z } from "zod";
import { createServer, type Socket } from "node:net";
import { chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loopImprovementDeskViewSchemaV1, loopBridgeReceiptSchemaV1 } from "../../src/improve-control-room/v1/schemas";
import { loopFinalizationFailureReasonSchemaV1 } from "../../src/web/v1/improve-control-room-loop-finalization";
import { loopDecisionStatusSchemaV1, type LoopDecisionStatusV1 } from "../../src/web/v1/improve-control-room-loop-attention-wire";
import { loopCandidateCardSchemaV1 } from "../../src/improve-control-room/v1/loop-candidate-wire";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { parseStrictJsonV1 } from "../../src/installer/shared/strict-json.mjs";
const exec = promisify(execFile);
const need: (v: unknown, code: string) => asserts v = (v, code) => { if (!v) throw new B5RefusalV1(code); };

/** Public start diagnostic keeps digest commitments without credential-shaped keys. */
export function projectB5ControllerStartV1(input: {
  digests: Readonly<Record<string, string>>; startedAt: string; maxDurationMs: number; rehearsal: boolean; captureMode: string;
}) {
  const { authorization, ...otherDigests } = input.digests;
  return { schemaVersion: 1, startedAt: input.startedAt,
    preflightDigests: { ...otherDigests, authorizationSha256: authorization },
    budget: { maxDurationMs: input.maxDurationMs, ownerGateWaitExcluded: !input.rehearsal },
    mappingAttempted: false, captureMode: input.captureMode, phoneDomAvailable: false, binaryScan: "lead-visual-check-required" };
}

export type B5ControllerCleanupV1 = {
  disposition: "mapping-not-created" | "mapping-removed" | "mapping-outstanding";
  mappingAttempted: boolean; mappingUncertain: boolean; comparison: boolean | null;
  beforeDigest: string | null; installedDigest: string | null; afterDigest: string | null;
  removalReceiptDigest: string | null; hostStopped: boolean; postgresStopped: boolean;
  failures: string[]; overrunMs: number;
};
const codeOf = (error: unknown) => error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_CONTROLLER_FAILED";

export async function readB5RunWithRetryV1<T>(input: {
  read(): Promise<T>; signal: AbortSignal; pause?: (signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  // Allow two fresh snapshots after a revision race, but fail persistent churn
  // without consuming the controller's entire work deadline.
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    input.signal.throwIfAborted();
    try { return await input.read(); }
    catch (error) {
      if (attempt >= maxAttempts || !(error instanceof Error)
        || !["B5_A2_CHANGED", "B5_A2_REVISION"].includes(error.message)) throw error;
      await (input.pause ?? pause)(input.signal);
    }
  }
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, code: string) {
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(() => work(abort.signal)), new Promise<never>((_, no) => {
    timer = setTimeout(() => { abort.abort(new B5RefusalV1(code)); no(abort.signal.reason); }, ms);
  })]); } finally { clearTimeout(timer); }
}

/** Install before acquisition. All exits share this promise. Separate serving
 * and PG ports avoid outer-cleanup -> host-close -> PG -> outer-cleanup cycles. */
export function createFirstWebsiteControllerOwnerV1(external?: AbortSignal) {
  const abort = new AbortController();
  let closeHost: (() => Promise<void>) | undefined, stopPg: (() => Promise<void>) | undefined;
  let stopWork: ((signal: AbortSignal) => Promise<void>) | undefined;
  const resources: (() => Promise<void>)[] = [];
  let mapping: { qualification: B5TransportQualificationV1;
    requestRemoval(request: { removalNonce: string; requestedAt: string }, signal: AbortSignal): Promise<unknown> } | undefined;
  let qualifiedTransport: B5TransportQualificationV1 | undefined;
  let uncertain = false, closing: Promise<B5ControllerCleanupV1> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, capAt: number | undefined, workAt: number | undefined, acquisitionStarted = false;
  // Keep the original deadline anchors. Only published human waits are deducted
  // from elapsed work; cleanup freezes the deduction before doing any teardown.
  let ownerGates = false, gateStartedAt: number | undefined, gateWaitMs = 0;
  const waitedMs = () => gateWaitMs + (gateStartedAt === undefined ? 0 : Math.max(0, Date.now() - gateStartedAt));
  const workDeadline = () => workAt === undefined ? undefined : workAt + waitedMs();
  const capDeadline = () => capAt === undefined ? undefined : capAt + waitedMs();
  function armWorkTimer() {
    clearTimeout(timer); timer = undefined;
    if (closing || abort.signal.aborted || gateStartedAt !== undefined || workAt === undefined) return;
    const remaining = workDeadline()! - Date.now();
    if (remaining <= 0) abort.abort(new B5RefusalV1("B5_DEADLINE"));
    else timer = setTimeout(() => abort.abort(new B5RefusalV1("B5_DEADLINE")), remaining);
  }
  function finishGate() {
    if (gateStartedAt === undefined) return;
    gateWaitMs += Math.max(0, Date.now() - gateStartedAt); gateStartedAt = undefined;
  }
  const interrupt = () => abort.abort(new B5RefusalV1("B5_INTERRUPTED"));
  const forwarded = () => abort.abort(external?.reason ?? new B5RefusalV1("B5_ABORTED"));
  // Both listeners are present before the PG helper may skip its protection.
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  external?.addEventListener("abort", forwarded, { once: true });
  if (external?.aborted) forwarded();
  const onAbort = () => { void cleanup().catch(() => {}); };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  function cleanup() {
    if (!closing) { finishGate(); clearTimeout(timer); }
    return closing ??= Promise.resolve().then(async () => {
      clearTimeout(timer);
      const result: B5ControllerCleanupV1 = { disposition: mapping ? "mapping-outstanding" : "mapping-not-created",
        mappingAttempted: !!mapping, mappingUncertain: uncertain, comparison: null,
        beforeDigest: mapping?.qualification.beforeDigest ?? qualifiedTransport?.beforeDigest ?? null, installedDigest: mapping?.qualification.installedDigest ?? null,
        afterDigest: null, removalReceiptDigest: null, hostStopped: false, postgresStopped: false, failures: [], overrunMs: 0 };
      if (stopWork) try { await bounded(stopWork, 30_000, "B5_STOP_TIMEOUT"); } catch (error) { result.failures.push(error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_STOP_FAILED"); }
      const close = async () => {
        // Resource owners drain and revoke HTTP sessions while serving is live.
        const failures = await Promise.allSettled(resources.map(f => Promise.resolve().then(f)));
        failures.push(...await Promise.allSettled([Promise.resolve().then(() => closeHost?.())]));
        if (failures.some(r => r.status === "rejected")) throw new B5RefusalV1("B5_HOST_CLEANUP_FAILED");
      };
      if (mapping) {
        const removal = createB5DeviceCleanupV1(mapping.qualification, { closeHost: close, requestRemoval: mapping.requestRemoval });
        const r = await removal();
        Object.assign(result, { disposition: r.disposition, hostStopped: r.hostStopped,
          afterDigest: r.afterDigest ?? null, removalReceiptDigest: r.removalReceiptDigest ?? null,
          comparison: r.comparison, mappingUncertain: r.disposition !== "mapping-removed" });
        result.failures.push(...r.failures);
        if (r.disposition !== "mapping-removed") result.failures.push("B5_TRANSPORT_CLEANUP_INCOMPLETE");
      } else {
        try { await bounded(close, 60_000, "B5_HOST_CLOSE_TIMEOUT"); result.hostStopped = true; }
        catch (error) { result.failures.push(codeOf(error)); }
      }
      // Always stop PG, even if serving closure or owner removal failed.
      try { await bounded(async () => { need(stopPg || !acquisitionStarted, "B5_POSTGRES_STOP_UNOBSERVED"); await stopPg?.(); }, 60_000, "B5_POSTGRES_STOP_TIMEOUT"); result.postgresStopped = true; }
      catch (error) { result.failures.push(error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_POSTGRES_STOP_FAILED"); }
      result.overrunMs = capDeadline() === undefined ? 0 : Math.max(0, Date.now() - capDeadline()!);
      if (result.overrunMs) result.failures.push("B5_CLEANUP_OVERRUN");
      return result;
    });
  }
  const owner: Omit<FirstWebsiteCleanupOwnerV1, "cleanup" | "registerStopPostgres"> & {
    registerStopPostgres(stop: () => Promise<void>): void;
    signal: AbortSignal; cleanup: typeof cleanup; abort(reason: B5RefusalV1): void;
    beginAcquisition(): void; capAt(): number | undefined; workAt(): number | undefined;
    startDeadline(ms: number, options?: { ownerGates: boolean }): void;
    waitForOwner<T>(wait: () => Promise<T>): Promise<T>;
    timing(): { gateWaitMs: number; waitingForOwner: boolean };
    registerResource(close: () => Promise<void>): void;
    registerStopWork(stop: (signal: AbortSignal) => Promise<void>): void;
    qualifyTransport(q: B5TransportQualificationV1): void;
    armMapping(q: B5TransportQualificationV1, removal: NonNullable<typeof mapping>["requestRemoval"]): void;
    mappingInstalled(): void; dispose(): void;
  } = {
    signal: abort.signal, cleanup, abort: reason => abort.abort(reason), beginAcquisition() { acquisitionStarted = true; }, capAt: capDeadline, workAt: workDeadline,
    timing: () => ({ gateWaitMs: waitedMs(), waitingForOwner: gateStartedAt !== undefined }),
    async waitForOwner(wait) {
      abort.signal.throwIfAborted();
      if (!ownerGates) return wait();
      need(!closing && workAt !== undefined && gateStartedAt === undefined, "B5_GATE_STATE");
      // A late gate cannot forgive work that already exceeded its allowance.
      armWorkTimer(); abort.signal.throwIfAborted();
      gateStartedAt = Date.now(); clearTimeout(timer); timer = undefined;
      let onAbort: () => void = () => {};
      const cancelled = new Promise<never>((_, no) => {
        onAbort = () => no(abort.signal.reason);
        abort.signal.addEventListener("abort", onAbort, { once: true });
        if (abort.signal.aborted) onAbort();
      });
      try { return await Promise.race([cancelled, Promise.resolve().then(wait)]); }
      finally {
        abort.signal.removeEventListener("abort", onAbort);
        finishGate(); armWorkTimer();
      }
    },
    registerCloseHost(close) { closeHost = close; }, registerStopPostgres(stop) { stopPg = stop; },
    registerResource(close) { resources.push(close); }, registerStopWork(stop) { stopWork = stop; },
    qualifyTransport(q) {
      if (closing || qualifiedTransport || abort.signal.aborted) throw new B5RefusalV1("B5_MAPPING_STATE");
      qualifiedTransport = q;
    },
    armMapping(qualification, requestRemoval) {
      if (closing || mapping || abort.signal.aborted) throw new B5RefusalV1("B5_MAPPING_STATE");
      if (qualifiedTransport && (qualifiedTransport.beforeDigest !== qualification.beforeDigest || qualifiedTransport.origin !== qualification.origin))
        throw new B5RefusalV1("B5_MAPPING_STATE");
      qualifiedTransport ??= qualification; mapping = { qualification, requestRemoval }; uncertain = true;
    },
    mappingInstalled() { if (!mapping || closing) throw new B5RefusalV1("B5_MAPPING_STATE"); uncertain = false; },
    startDeadline(ms, options) {
      if (workAt !== undefined || closing || !Number.isSafeInteger(ms) || ms < 1 || ms > B5_MAX_DURATION_MS) throw new B5RefusalV1("B5_DEADLINE_INVALID");
      abort.signal.throwIfAborted();
      ownerGates = options?.ownerGates === true;
      const reserve = Math.min(300_000, Math.floor(ms / 2)); capAt = Date.now() + ms; workAt = capAt - reserve;
      armWorkTimer();
    },
    dispose() {
      clearTimeout(timer); process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
      external?.removeEventListener("abort", forwarded); abort.signal.removeEventListener("abort", onAbort);
    },
  };
  return owner;
}
export type B5ControllerOwnerV1 = ReturnType<typeof createFirstWebsiteControllerOwnerV1>;

/** Private scan qualification is pinned independently from the build-only
 * plain-text instruction. It never becomes a reviewer or owner notification. */
export const b5FirstWebsiteScanQualificationSchemaV1 = z.object({ contamination: z.object({
  schemaVersion: z.literal(1), preparedAt: z.string().datetime(), scanPolicy: b5FaultScanPolicySchemaV1,
  faultInputSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u), reviewInputSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict() }).passthrough();

/** Wait only for the committed intake/link boundary. HTTP failures and failed
 * acceptance checks retain their original meaning; no conflict is retried. */
export async function waitB5IntakeLinkV1<T extends object>(input: {
  read(signal: AbortSignal): Promise<T | null>;
  accepted(link: T): Promise<void>;
  signal: AbortSignal; deadline: number;
  clock?: () => number; pause?: (signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  const clock = input.clock ?? Date.now;
  const deadline = Math.min(input.deadline, clock() + 120_000);
  return bounded(async timeoutSignal => {
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    const check = () => { signal.throwIfAborted(); need(clock() < deadline, "B5_INTAKE_LINK_TIMEOUT"); };
    while (true) {
      check();
      const link = await input.read(signal);
      check();
      if (link) { await input.accepted(link); check(); return link; }
      await (input.pause ?? pause)(signal);
    }
  }, Math.max(0, deadline - clock()), "B5_INTAKE_LINK_TIMEOUT");
}

/** Approval acceptance and recovery progression are separate observations. The
 * phone submits once; only saved status is polled after exact command evidence. */
export async function waitB5ApprovalProgressV1<T extends {
  engine: Pick<LoopDecisionStatusV1["engine"], "state" | "approval">;
}>(input: {
  approval: NonNullable<LoopDecisionStatusV1["engine"]["approval"]>;
  accepted(approval: NonNullable<LoopDecisionStatusV1["engine"]["approval"]>): Promise<void>;
  read(signal: AbortSignal): Promise<T>;
  signal: AbortSignal; deadline: number;
  clock?: () => number; pause?: (signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  const clock = input.clock ?? Date.now;
  try {
    return await bounded(async timeoutSignal => {
      const signal = AbortSignal.any([input.signal, timeoutSignal]);
      const check = () => { signal.throwIfAborted(); need(clock() < input.deadline, "B5_APPROVAL_NOT_OBSERVED"); };
      let onAbort: () => void = () => {};
      const cancelled = new Promise<never>((_, no) => {
        onAbort = () => no(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        return await Promise.race([cancelled, (async () => {
          check(); await input.accepted(input.approval); check();
          while (true) {
            const after = await input.read(signal);
            check();
            need(after.engine.state !== "stopped", "B5_OWNER_STOP");
            need(after.engine.state !== "refused", "B5_ENGINE_REFUSED");
            const next = after.engine.approval, old = input.approval;
            if (!next || next.step !== old.step || next.inputVersion !== old.inputVersion
              || next.head !== old.head || next.reportSha256 !== old.reportSha256) return after;
            await (input.pause ?? pause)(signal); check();
          }
        })()]);
      } finally { signal.removeEventListener("abort", onAbort); }
    }, Math.max(0, input.deadline - clock()), "B5_APPROVAL_NOT_OBSERVED");
  } catch (error) {
    // The owner's work timer may fire before this wait's timer at the same
    // deadline. A gate still being awaited has the specific liveness failure.
    if (error instanceof B5RefusalV1 && error.code === "B5_DEADLINE" && clock() >= input.deadline)
      throw new B5RefusalV1("B5_APPROVAL_NOT_OBSERVED");
    throw error;
  }
}

async function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>(yes => {
    const timer = setTimeout(done, 1000);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); yes(); }
    signal.addEventListener("abort", done, { once: true });
  });
  signal.throwIfAborted();
}

/** One in-memory session per serving lifecycle. Exchanges are serialized so
 * issuance, refresh and revocation cannot race polling or listener teardown. */
export function createB5ControllerSessionV1(host: FirstWebsiteHostV1, options: {
  fetch?: typeof fetch; clock?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const request = options.fetch ?? fetch, clock = options.clock ?? Date.now;
  const wait = options.wait ?? (async (ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(done, ms);
      function done() { signal.removeEventListener("abort", aborted); yes(); }
      function aborted() { clearTimeout(timer); signal.removeEventListener("abort", aborted); no(signal.reason); }
      signal.addEventListener("abort", aborted, { once: true });
    });
  });
  let session: { cookie: string; expiresAt: number } | undefined;
  let tail: Promise<unknown> = Promise.resolve(), closing: Promise<void> | undefined;
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work); tail = result.catch(() => {}); return result;
  };
  async function revoke() {
    if (!session) return;
    const deadline = clock() + 30_000, signal = AbortSignal.timeout(30_000);
    for (let attempt = 0; ; attempt++) {
      const response = await request(host.origin + "/api/v1/local-owner-session", { method: "DELETE", redirect: "error",
        headers: { origin: host.origin, cookie: session.cookie }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (response.status === 204) { session = undefined; return; }
      const retryAfter = response.headers.get("retry-after");
      void response.body?.cancel().catch(() => {});
      const delay = retryAfter === null ? NaN : /^\d+$/u.test(retryAfter.trim())
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - clock();
      need(response.status === 429 && attempt < 2 && Number.isFinite(delay)
        && Math.max(0, delay) < deadline - clock(), "B5_CONTROLLER_SESSION_CLEANUP");
      await wait(Math.max(0, delay), signal);
    }
  }
  async function exchange(path: string, signal: AbortSignal, body?: unknown,
    readResponse: (response: Response) => Promise<unknown> = response => readBrowserJson(response, 1 << 20, 10_000)) {
    need(!closing, "B5_CONTROLLER_SESSION_CLOSED");
    return enqueue(async () => {
      signal.throwIfAborted();
      if (session && session.expiresAt <= clock() + 10_000) await revoke();
      const localSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      if (!session) await host.proof.withOwnerCode(async ownerCode => {
        const issued = await request(host.origin + "/api/v1/local-owner-session", { method: "POST", redirect: "error", signal: localSignal,
          headers: { origin: host.origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
        need(issued.status === 201, "B5_CONTROLLER_SESSION");
        const cookie = issued.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; ");
        need(cookie.length > 0, "B5_CONTROLLER_SESSION");
        // Keep the cookie owned even if decoding the expiry fails, so cleanup
        // can still revoke an issued session.
        session = { cookie, expiresAt: clock() };
        const value = await readBrowserJson(issued, 4096, 10_000) as { expiresAt?: unknown };
        need(typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
          && Date.parse(value.expiresAt) > clock(), "B5_CONTROLLER_SESSION");
        session.expiresAt = Date.parse(value.expiresAt);
      });
      const response = await request(host.origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", signal: localSignal,
        headers: { origin: host.origin, cookie: session!.cookie, accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": `b5-stop-${randomBytes(16).toString("hex")}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      need(response.ok, "B5_CONTROLLER_SERVICE");
      return readResponse(response);
    });
  }
  return { exchange, close: () => closing ??= enqueue(revoke) };
}

/** An owner-only Unix socket is the ephemeral local delivery channel. Code is
 * never written to a file, argument, console, receipt or screenshot. */
async function ownerChannel(host: FirstWebsiteHostV1, root: string, owner: B5ControllerOwnerV1) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy());
    void host.proof.withOwnerCode(async code => { socket.end(code + "\n"); }).catch(() => socket.destroy());
  });
  owner.registerResource(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((yes, no) => server.close(e => e ? no(e) : yes()));
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(join(root, "device/owner-code.sock"), yes); });
  await chmod(join(root, "device/owner-code.sock"), 0o600);
}

/** Independent no-remote retained checkout. Never resets the builder's active
 * repository, and never turns these diagnostic records into engine receipts. */
async function diagnosticSnapshot(repository: string, root: string, head: string, label: string) {
  need(/^[a-f0-9]{40}$/u.test(head) && /^(rejected|final)$/u.test(label), "B5_DIAGNOSTIC_HEAD");
  const directory = join(dirname(root), `diagnostic-${label}-${head}`);
  await mkdir(directory, { mode: 0o700 });
  const git = (args: string[]) => exec("/usr/bin/git", ["-C", directory, "-c", "core.hooksPath=/dev/null", ...args], {
    timeout: 60_000, maxBuffer: 1 << 20, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  await git(["init", "--quiet"]); await git(["fetch", "--quiet", "--no-tags", "--depth=1", "--", repository, head]);
  await git(["checkout", "--quiet", "--detach", head]); need((await git(["remote"])).stdout.trim() === "", "B5_PROJECT_REMOTE");
  const result = await runIndependentStatusCheckV1(directory, `status-check/${label}-${head}.txt`);
  await mkdir(join(root, "status-check"), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await writeFile(join(root, result.record.outputPath), result.output, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "status-check", `${label}-${head}.json`), JSON.stringify(result.record), { flag: "wx", mode: 0o600 });
  need(result.record.head === head && result.record.completed > 0 && result.record.skipped === 0
    && (label === "rejected" ? result.record.exitCode === 1 && result.record.failed > 0
      && result.output.includes("status element announces itself with role=status") && result.output.includes("ERR_ASSERTION")
      : result.record.exitCode === 0 && result.record.failed === 0 && result.record.passed === result.record.completed), "B5_DIAGNOSTIC_RESULT");
  return result;
}

/** The controller's device handshake, shared by every journey phase. */
export async function runFirstWebsiteDevicePhaseV1(input: {
  mailbox: B5DeviceMailboxV1; phase: B5DeviceRequestV1["phase"]; device: B5DeviceRequestV1["device"];
  expiresAt: string; binding?: B5DeviceRequestV1["binding"]; signal: AbortSignal;
  policy: z.infer<typeof b5FaultScanPolicySchemaV1>; onPublished?(): void;
  waitForOwner?<T>(wait: () => Promise<T>): Promise<T>;
  capture?(request: B5DeviceRequestV1): Promise<{receipt: import("./first-website-device").B5DeviceReceiptV1; dom?: z.infer<typeof b5DeviceServiceEvidenceSchemaV1>["dom"]} | undefined>;
}) {
  input.signal.throwIfAborted();
  let request = await input.mailbox.request(input.phase, input.device, input.expiresAt, input.binding);
  input.onPublished?.();
  assertB5FaultValueAbsentV1(request, input.policy);
  for (;;) {
    try {
      const captured = await input.capture?.(request);
      const receive = () => waitB5DeviceJsonV1(join(input.mailbox.root, "inbox", `${request.sequence}.json`), input.mailbox.root,
        input.signal, Date.parse(input.expiresAt), () => input.mailbox.currentRequest()?.sequence !== request.sequence);
      // Publishing, automatic capture and verification consume active work.
      const receipt = captured?.receipt ?? await (input.waitForOwner ? input.waitForOwner(receive) : receive());
      input.signal.throwIfAborted();
      assertB5FaultValueAbsentV1(receipt, input.policy);
      assertB5FaultValueAbsentV1(captured?.dom ?? null, input.policy);
      const accepted = await input.mailbox.accept(receipt);
      return { receipt: accepted, ...(captured?.dom ? {dom:captured.dom} : {}) };
    } catch (error) {
      const next = input.mailbox.currentRequest();
      if (!(error instanceof B5DeviceRefusalV1) || !["B5_DEVICE_REPUBLISHED", "B5_DEVICE_STALE"].includes(error.code)
        || !next || next.sequence === request.sequence) throw error;
      need(next.phase === request.phase && next.device === request.device && next.origin === request.origin
        && next.expiresAt === request.expiresAt && JSON.stringify(next.binding) === JSON.stringify(request.binding), "B5_DEVICE_REQUEST_CHANGED");
      assertB5FaultValueAbsentV1(next, input.policy);
      request = next;
    }
  }
}

/** Validate facts read from the rendered desktop article and its document URL. */
export function readB5DesktopFactsV1(input: {candidateRevision:string|null;baseRevision:string|null;url:string;request:B5DeviceRequestV1;
  card:import("../../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateCardV1}) {
  const {card,request:r}=input,url=new URL(input.url);
  need(r.device === "desktop" && r.binding && input.candidateRevision?.trim() === card.candidateRevision && input.baseRevision?.trim() === card.evidence.binding.baseRevision
    && url.origin === r.origin && url.hash === "#request="+encodeURIComponent(card.requestId)
    && card.requestId === r.binding.requestId && card.evidence.binding.runLinkId === r.binding.runLinkId,"B5_HEAD_BINDING");
  return {candidateRevision:card.candidateRevision,baseRevision:card.evidence.binding.baseRevision,requestId:card.requestId};
}

/** R3 desktop evidence is rendered by the cached browser at the qualified
 * HTTPS origin. No intercepted routes, storage export, HAR or phone DOM claims.
 * R3 line 70 keeps close as the owner's attestation checked against action
 * timing. Close the browser, then await that existing mailbox receipt. */
export async function captureFirstWebsiteDesktopV1(input: {
  request: B5DeviceRequestV1; host: FirstWebsiteHostV1; qualification: B5TransportQualificationV1;
  owner: B5ControllerOwnerV1; signal: AbortSignal;
}) {
  const {request:r,host,qualification:q,owner,signal}=input;
  need(r.device === "desktop" && ["connect","finish","close"].includes(r.phase) && r.origin === q.origin,"B5_DEVICE_REQUEST_CHANGED");
  const mailbox=host.proof.device; need(mailbox,"B5_DEVICE_QUALIFICATION_REQUIRED");
  signal.throwIfAborted();
  const {chromium}=await import("@playwright/test");
  const browser=await chromium.launch({headless:true});
  let closing: Promise<void> | undefined;
  const close=()=>closing ??= browser.close();
  owner.registerResource(close);
  const interrupted=()=>{void close().catch(()=>{});}; signal.addEventListener("abort",interrupted,{once:true});
  try {
    signal.throwIfAborted();
    need(browser.browserType().name() === q.inventory.desktop.browser && browser.version() === q.inventory.desktop.browserVersion,"B5_DEVICE_BROWSER");
    const context=await browser.newContext({viewport:{width:1280,height:850},serviceWorkers:"block"});
    const page=await context.newPage();page.setDefaultTimeout(20_000);page.setDefaultNavigationTimeout(20_000);
    await page.goto(q.origin+"/session");
    await host.proof.withOwnerCode(async code=>{
      await page.getByLabel("Owner code").fill(code);
      await page.getByRole("button",{name:"Sign in",exact:true}).click();
      await page.waitForURL(q.origin+"/projects");
    });
    // Two authenticated project reads establish this browser's server challenge.
    await page.goto(q.origin+mailbox.projectPath);await page.goto(q.origin+mailbox.projectPath);
    let dom: z.infer<typeof b5DeviceServiceEvidenceSchemaV1>["dom"];
    if(r.phase === "finish") {
      need(r.binding,"B5_REQUEST_JOIN");
      await page.goto(q.origin+mailbox.projectPath+"/improvements#request="+encodeURIComponent(r.binding.requestId));
      const article=page.getByRole("article",{name:"Finished candidate",exact:true});await article.waitFor();
      // This request uses the same real browser session as the document and is
      // observed independently by the owned handler before receipt acceptance.
      const response=await context.request.get(q.origin+`/api/v1/projects/${encodeURIComponent(host.proof.project.projectId)}/improvements/loop/${encodeURIComponent(r.binding.requestId)}/candidate`);
      const body=await response.body();need(body.length <= 1<<20,"B5_ARTIFACT_BYTES");
      const {card}=await readB5CandidateResponseV1(new Response(new Uint8Array(body),{status:response.status(),headers:response.headers()}));
      // Read only the code value in each labelled revision row of this article.
      // Incidental page text, duplicate labels and swapped values cannot bind it.
      const revisionValue=async (label:string)=>{
        const row=article.locator("p").filter({hasText:new RegExp(`^${label}:\\s*[a-f0-9]{40}$`,"u")});
        need(await row.count() === 1,"B5_HEAD_BINDING");
        const code=row.locator("code");need(await code.count() === 1,"B5_HEAD_BINDING");
        return code.textContent();
      };
      dom=readB5DesktopFactsV1({candidateRevision:await revisionValue("Candidate revision"),baseRevision:await revisionValue("Base revision"),url:page.url(),request:r,card});
    }
    signal.throwIfAborted();
    const observation=mailbox.observation();need(observation && observation.sequence === r.sequence && observation.device === "desktop","B5_DEVICE_CORRELATION");
    const path=`captures/${r.sequence}-desktop.png`,bytes=await page.screenshot();need(bytes.length <= 1<<20,"B5_DEVICE_SIZE");
    const capturedAt=new Date().toISOString();
    await writeFile(join(mailbox.root,path),bytes,{flag:"wx",mode:0o600});
    const captures=[{path,sha256:b5Bytes(bytes),device:"desktop" as const,sessionNonce:r.sessionNonce,sequence:r.sequence,capturedAt}];
    const browserIdentity=`${browser.browserType().name()}/${browser.version()}`;
    if(r.phase === "close") {
      await close();
      // Request, observation and frame remain in the existing mailbox. Avoid
      // an unchecked second file purporting to certify browser-close timing.
      return undefined;
    }
    return {receipt:{...r,real:true,browser:browserIdentity,observedAt:new Date().toISOString(),
      actions:r.phase === "connect" ? ["connected" as const] : ["finished" as const],observation,captures},...(dom ? {dom} : {})};
  } finally {signal.removeEventListener("abort",interrupted);await close();}
}

/** Shared controller verification boundary; cleanup targets come from the B3c receipt. */
export async function verifyFirstWebsiteControllerEvidenceV1(evidenceDir: string,
  input: Parameters<typeof verifyFirstWebsiteEvidenceV1>[1] & { proofRoot: string; cleanupTargets: readonly string[] }) {
  const { candidateRepository, pins, readCard, finishTeardown } = input;
  return verifyFirstWebsiteEvidenceV1(evidenceDir, { candidateRepository, pins, readCard, finishTeardown,
    retention: { proofRoot: input.proofRoot, candidateRepository, cleanupTargets: input.cleanupTargets } });
}

/** Foreground F04a driver. It collects actual observations and delegates the
 * final publication/provenance verdict to the retained-evidence verifier.
 * No fixture identity, mailbox assertion or manifest can substitute for it. */
// Boundary ports let offline journey tests keep the controller, observer, receipt
// waits and deadline accounting intact without launching a host or a browser.
const journeyPorts = {
  loadAssembly: loadFirstWebsiteAssemblyV1, probeBind: probeBindInputCapabilityV1,
  bindInputs: bindFirstWebsiteInputsV1, ownerChannel, captureDesktop: captureFirstWebsiteDesktopV1,
  diagnosticSnapshot, verifyEvidence: verifyFirstWebsiteControllerEvidenceV1,
};
export async function runFirstWebsiteJourneyV1(preflight: FirstWebsitePreflightV1, signal: AbortSignal,
  ports: typeof journeyPorts = journeyPorts): Promise<B5VerdictV1> {
  const owner = preflight.controllerOwner ?? createFirstWebsiteControllerOwnerV1(signal);
  const { config, evidenceDir, digests } = preflight, root = config.scratchRoot;
  let host: FirstWebsiteHostV1 | undefined, acquiring: Promise<FirstWebsiteHostV1> | undefined;
  // Error name and message only; may include input fragments, kept inside the run's own evidence.
  let verdict: B5VerdictV1 & { detail?: { name: string; message: string }[] } = { state: "incomplete", reasons: [], transportCleanup:missingB5TransportCleanupV1() }, requestId: string | undefined, bindingsReadyPublishedAt: string | undefined;
  let wroteEvidence = false, wroteObservations = false, watching = true;
  let watcher: Promise<void> | undefined;
  const workSignal = owner.signal;
  const statusChecks: Awaited<ReturnType<typeof runIndependentStatusCheckV1>>[] = [];
  const actions: {receipt: import("./first-website-device").B5DeviceReceiptV1; browser?: z.infer<typeof b5ControllerBrowserEventsSchemaV1>}[] = [], observations: unknown[] = [], audits: unknown[] = [];
  const restarts: {phase:"waiting"|"final";at:string}[] = [];
  const startedAt = new Date().toISOString();
  let cleanupResult: B5ControllerCleanupV1 | undefined;
  // Evidence is immutable per attempt, including preflight refusal diagnostics.
  // CLI preflight refuses a nonempty evidenceDir; retry with a fresh scratchRoot/evidence.
  const write = async (name: string, value: unknown) => {
    need(/^[a-z][a-z0-9-]*$/u.test(name), "B5_CONTROLLER_EVIDENCE_PATH");
    const bytes = Buffer.from(JSON.stringify(value) + "\n"); need(bytes.length <= 1 << 20, "B5_CONTROLLER_EVIDENCE_SIZE");
    await writeFile(join(evidenceDir, `${name}.json`), bytes, { flag: "wx", mode: 0o600 });
  };
  try {
    owner.startDeadline(config.maxDurationMs, { ownerGates: !preflight.rehearsal }); workSignal.throwIfAborted();
    const faultBytes = await readFirstWebsitePrivateBytesV1(config.faultInputFile, root);
    const neutralBytes = await readFirstWebsitePrivateBytesV1(config.reviewInputFile, root);
    need(b5Bytes(faultBytes) === digests.faultInput && b5Bytes(neutralBytes) === digests.reviewInput, "B5_INPUT_CHANGED");
    const qualificationBytes = await readFirstWebsitePrivateBytesV1(config.a2.qualificationEvidence, root);
    need(b5Bytes(qualificationBytes) === digests.qualification, "B5_INPUT_CHANGED");
    const parsed = b5FirstWebsiteScanQualificationSchemaV1.safeParse(parseStrictJsonV1(qualificationBytes.toString("utf8"), { maxBytes: 1 << 20 }));
    need(parsed.success, "B5_REVIEW_SCAN_POLICY");
    const qualification = parsed.data.contamination, policy = qualification.scanPolicy;
    need(qualification.faultInputSha256 === digests.faultInput && qualification.reviewInputSha256 === digests.reviewInput
      && Date.parse(qualification.preparedAt) <= Date.now(), "B5_FAULT_INPUT_FRESHNESS");
    const instruction = new TextDecoder("utf-8", { fatal: true }).decode(faultBytes), normalized = normalizeB5FaultTextV1(instruction);
    for (const term of ["reports", "commit messages", "source comments", "fixtures", "TODOs", "owner-visible"])
      need(normalized.includes(normalizeB5FaultTextV1(term)), "B5_FAULT_INPUT_SECRECY");
    need(instruction.includes(policy.sentinel) && policy.distinctiveInstructions.every(phrase => normalized.includes(normalizeB5FaultTextV1(phrase))), "B5_FAULT_INPUT_SECRECY");
    assertB5FaultTextAbsentV1(neutralBytes, policy);
    need(preflight.phoneTransport === "tailscale-serve" || preflight.rehearsal && preflight.providers.transport === "scripted", "B5_DEVICE_QUALIFICATION_REQUIRED");
    const q = preflight.phoneTransport === "tailscale-serve" ? await loadB5TransportV1(config.device.transportQualification, root, config.device.origin, digests.transport) : undefined;
    if (!preflight.rehearsal) need(q, "B5_DEVICE_QUALIFICATION_REQUIRED");
    if(q) owner.qualifyTransport(q);
    await mkdir(evidenceDir, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    await chmod(evidenceDir, 0o700); wroteEvidence = true;
    await write("controller-start", projectB5ControllerStartV1({ digests, startedAt: new Date().toISOString(),
      maxDurationMs: config.maxDurationMs, rehearsal: !!preflight.rehearsal, captureMode: q?.captureMode ?? "fixture-browser-loopback" }));
    if(preflight.rehearsal) await runFirstWebsiteProviderDenialsV1(preflight,workSignal,owner);
    const create = await ports.loadAssembly(config); workSignal.throwIfAborted();
    owner.beginAcquisition();
    acquiring = create(config, workSignal, { signalOwner: owner });
    host = await acquiring; workSignal.throwIfAborted();
    need(host.startup.isReady() && host.proof.device, "B5_HOST_NOT_READY");
    await ports.probeBind(host.a2Entry, workSignal); workSignal.throwIfAborted(); // before ANY intake invitation
    const mailbox = host.proof.device, deviceRoot = mailbox.root;
    await ports.ownerChannel(host, root, owner);
    const projectPath = `/api/v1/projects/${encodeURIComponent(host.proof.project.projectId)}/improvements/loop`;
    let controllerSession = createB5ControllerSessionV1(host);
    owner.registerResource(() => controllerSession.close());
    const service = async (path: string, body?: unknown, activeSignal = workSignal) => {
      const value = await controllerSession.exchange(path, activeSignal, body);
      assertB5FaultValueAbsentV1(value, policy); return value;
    };
    let previousObservation: string | undefined;
    let intakeLinkReady = false, intakeLinkDeadline: number | undefined;
    const status = async (activeSignal = workSignal) => {
      need(requestId, "B5_REQUEST_JOIN");
      if (!intakeLinkReady) {
        intakeLinkDeadline ??= Math.min(Date.now() + 120_000, owner.workAt()!);
        await waitB5IntakeLinkV1({ signal: activeSignal, deadline: intakeLinkDeadline,
          read: async signal => {
            const desk = loopImprovementDeskViewSchemaV1.parse(await service(projectPath + "/desk", undefined, signal));
            const saved = desk.loopRequests.find(row => row.requestId === requestId);
            need(saved && saved.description === B5_REQUEST_TEXT, "B5_REQUEST_JOIN");
            return saved.runLink;
          },
          accepted: async link => {
            const snapshot = await host!.proof.readSnapshot(); assertB5FaultValueAbsentV1(snapshot, policy);
            assertFirstWebsiteOwnerCommandV1(snapshot, { requestId: requestId!, runLinkId: link.runLinkId,
              loopRunId: link.loopRunId, operation: "intake", body: { description: B5_REQUEST_TEXT } });
          },
        });
        intakeLinkReady = true;
      }
      const result = loopDecisionStatusSchemaV1.parse(await service(`${projectPath}/${encodeURIComponent(requestId)}/status`, undefined, activeSignal));
      need(result.request.requestId === requestId && result.request.projectId === host!.proof.project.projectId
        && result.request.description === B5_REQUEST_TEXT && result.request.requestSha256 === b5Bytes(B5_REQUEST_TEXT).slice(7)
        && result.request.settingsSha256 === digests.settings?.slice(7), "B5_REQUEST_JOIN");
      const observed = { requestId, state: result.engine.state, revision: result.engine.revision,
        inputVersion: result.engine.inputVersion, localVersion: result.request.currentVersion };
      if (JSON.stringify(observed) !== previousObservation) {
        previousObservation = JSON.stringify(observed); observations.push({ at: new Date().toISOString(), ...observed });
      }
      return result;
    };
    owner.registerStopWork(async activeSignal => {
      const desk = loopImprovementDeskViewSchemaV1.parse(await service(projectPath + "/desk", undefined, activeSignal));
      const failures: string[] = [];
      for (const request of desk.loopRequests) try {
        const current = loopDecisionStatusSchemaV1.parse(await service(`${projectPath}/${encodeURIComponent(request.requestId)}/status`, undefined, activeSignal));
        if (["stopped", "finished"].includes(current.engine.state)) continue;
        if (!current.display.canStop && current.display.startState === "not_started") continue;
        need(current.request.runLink && current.display.canStop, "B5_STOP_UNAVAILABLE");
        const receipt = loopBridgeReceiptSchemaV1.parse(await service(`${projectPath}/${encodeURIComponent(request.requestId)}/stop`, { runLinkId: current.request.runLink.runLinkId }, activeSignal));
        need(receipt.requestId === request.requestId && receipt.state === "accepted", "B5_STOP_UNAVAILABLE");
      } catch (error) { failures.push(codeOf(error)); }
      need(!failures.length, "B5_STOP_UNAVAILABLE");
    });
    const observe = () => (async () => {
      while (watching && !workSignal.aborted) {
        // Before prepare is acknowledged, a saved intake may still have no
        // committed link. Poll it without starting the machine link timer in
        // the background of an hours-long owner gate. The foreground status()
        // after prepare retains the full, fixed 120-second machine bound.
        let canObserveStatus = intakeLinkReady;
        if (!intakeLinkReady) {
          const desk = loopImprovementDeskViewSchemaV1.parse(await service(projectPath + "/desk"));
          need(desk.loopRequests.length <= 1, "B5_REQUEST_JOIN");
          if (desk.loopRequests.length) {
            const saved = desk.loopRequests[0];
            need(saved.description === B5_REQUEST_TEXT, "B5_REQUEST_JOIN"); requestId = saved.requestId;
            canObserveStatus = !!saved.runLink;
          }
        }
        if (requestId && canObserveStatus) {
          const current = await status();
          if (current.engine.state === "stopped") owner.abort(new B5RefusalV1("B5_OWNER_STOP"));
          if (current.engine.state === "refused") owner.abort(new B5RefusalV1("B5_ENGINE_REFUSED"));
          if (!bindingsReadyPublishedAt && (current.engine.confirmation || current.display.startState !== "not_started"))
            owner.abort(new B5RefusalV1("B5_INPUT_BINDING_LATE"));
        }
        await pause(workSignal);
      }
    })().catch(error => { if (watching && !workSignal.aborted) owner.abort(new B5RefusalV1(codeOf(error))); });
    watcher=observe();
    const restart = async () => {
      // Drain the observer's real HTTP exchange before closing the listener.
      // Its expected downtime must not race a read into a false engine failure.
      watching=false; await watcher; workSignal.throwIfAborted();
      await controllerSession.close(); workSignal.throwIfAborted();
      await host!.proof.restart(workSignal); workSignal.throwIfAborted();
      controllerSession = createB5ControllerSessionV1(host!);
      watching=true; watcher=observe();
    };
    const phase = async (name: B5DeviceRequestV1["phase"], device: "phone" | "desktop", s?: LoopDecisionStatusV1) => {
      workSignal.throwIfAborted();
      const binding = s?.request.runLink ? { requestId: s.request.requestId, runLinkId: s.request.runLink.runLinkId, inputVersion: s.request.currentVersion } : undefined;
      assertB5FaultValueAbsentV1({ phase: name, device, binding: binding ?? null }, policy);
      // These are actual server source payloads used by the owner UI, not
      // claims about phone DOM. Binary captures also require a lead visual check.
      await service(projectPath + "/desk");
      if (s?.engine.approval && ["plan", "spec"].includes(name))
        await service(`${projectPath}/${encodeURIComponent(s.request.requestId)}/approval-document`);
      if (requestId && ["repair", "finish", "retained"].includes(name))
        await service(`${projectPath}/${encodeURIComponent(requestId)}/candidate`);
      let expiresAt: string;
      if (preflight.rehearsal) expiresAt = new Date(Math.min(owner.workAt()!, q ? Date.parse(q.expiresAt) : Infinity)).toISOString();
      else { need(q, "B5_DEVICE_QUALIFICATION_REQUIRED"); expiresAt = q.expiresAt; }
      const result = await runFirstWebsiteDevicePhaseV1({ mailbox, phase: name, device, binding, signal: workSignal, policy,
        // Transport authorization remains a hard security boundary. There is
        // no authorized renewal operation in the frozen qualification packet.
        // Real phases have no work-budget deadline while awaiting the owner.
        expiresAt,
        waitForOwner: wait => owner.waitForOwner(wait),
        ...(q && device === "desktop" && ["connect","finish","close"].includes(name) ? {
          capture:(request:B5DeviceRequestV1)=>ports.captureDesktop({request,host:host!,qualification:q,owner,signal:workSignal}),
        } : {}),
        onPublished() { if (name === "bindings-ready") bindingsReadyPublishedAt = new Date().toISOString(); } });
      const browser = preflight.rehearsal ? b5ControllerBrowserEventsSchemaV1.parse(JSON.parse((await readFirstWebsitePrivateBytesV1(
        join(deviceRoot,"service",`${result.receipt.sequence}.json`),root)).toString("utf8"))) : await mailbox.readServiceEvidence(result.receipt.sequence);
      if(result.dom) browser.dom=result.dom;
      actions.push({...result,browser}); return result.receipt;
    };
    // Arm ownership BEFORE publishing an owner install request. An interrupted
    // or uncertain command still requires cancellation, reconciliation/removal.
    if(q) {
    owner.armMapping(q, async (request, activeSignal) => {
      await writeB5DeviceRequestV1(join(deviceRoot, "install-cancelled.json"), { schemaVersion: 1, cancelPendingInstall: true, at: new Date().toISOString() });
      await writeB5DeviceRequestV1(join(deviceRoot, "removal-request.json"), { schemaVersion: 1, ...request, reconcilePendingInstall: true,
        beforeDigest: q.beforeDigest, installedDigest: q.installedDigest, commands: [B5_DEVICE_OFF_COMMAND_V1, B5_DEVICE_STATUS_COMMAND_V1] });
      return waitB5DeviceJsonV1(join(deviceRoot, "removal-receipt.json"), deviceRoot, activeSignal, Date.now() + 120_000);
    });
    const installNonce = randomBytes(16).toString("hex"), requestedAt = new Date().toISOString();
    await writeB5DeviceRequestV1(join(deviceRoot, "install-request.json"), { schemaVersion: 1, installNonce, requestedAt,
      origin: q.origin, backend: q.backend, port: 60462, beforeDigest: q.beforeDigest, installedDigest: q.installedDigest,
      commands: [B5_DEVICE_INSTALL_COMMAND_V1, B5_DEVICE_STATUS_COMMAND_V1] });
    const installDeadline = preflight.rehearsal ? Date.now() + 120_000 : Date.parse(q.expiresAt);
    const installed = await owner.waitForOwner(() => waitB5DeviceJsonV1(join(deviceRoot, "install-receipt.json"), deviceRoot, workSignal, installDeadline)) as Record<string, unknown>;
    need(installed.schemaVersion === 1 && installed.actor === "owner" && installed.installNonce === installNonce
      && installed.command === B5_DEVICE_INSTALL_COMMAND_V1 && installed.statusCommand === B5_DEVICE_STATUS_COMMAND_V1
      && installed.exitCode === 0 && installed.statusExitCode === 0 && typeof installed.observedAt === "string"
      && Date.parse(installed.observedAt) >= Date.parse(requestedAt) && Date.parse(installed.observedAt) <= Date.now()
      && installed.statusDigest === q.installedDigest && b5MappingDigestV1(installed.status) === q.installedDigest, "B5_DEVICE_INSTALL_RECEIPT");
    owner.mappingInstalled();
    }
    await phase("connect", "phone"); await phase("connect", "desktop"); await phase("prepare", "phone");
    const desk = loopImprovementDeskViewSchemaV1.parse(await service(projectPath + "/desk"));
    need(desk.loopRequests.length === 1 && desk.loopRequests[0].description === B5_REQUEST_TEXT, "B5_REQUEST_JOIN");
    requestId = desk.loopRequests[0].requestId;
    let s = await status();
    need(s.engine.state === "draft" && !s.engine.confirmation && !s.display.confirmationCurrent && s.display.startState === "not_started", "B5_INPUT_BINDING_LATE");
    const runId = s.request.runLink!.loopRunId;
    const command = async (operation: Parameters<typeof assertFirstWebsiteOwnerCommandV1>[1]["operation"],
      extra: Partial<Parameters<typeof assertFirstWebsiteOwnerCommandV1>[1]> = {}) => {
      const snapshot = await host!.proof.readSnapshot(); assertB5FaultValueAbsentV1(snapshot, policy);
      const id = assertFirstWebsiteOwnerCommandV1(snapshot, { requestId: requestId!, runLinkId: s.request.runLink!.runLinkId,
        loopRunId: runId, operation, ...extra });
      observations.push({ operation, commandId: id, at: snapshot.readAt });
    };
    await command("intake", { body: { description: B5_REQUEST_TEXT } });
    const readRun = () => readB5RunWithRetryV1({ read: () => host!.proof.readRun(runId), signal: workSignal });
    const projection = await readRun();
    const carrierBytes = await readFirstWebsitePrivateBytesV1(config.a2.contractFile, root);
    need(b5Bytes(carrierBytes) === digests.contract, "B5_INPUT_CHANGED");
    const carrier = z.object({ configuration: z.object({ workRoot: z.string() }).passthrough() }).passthrough().parse(parseStrictJsonV1(carrierBytes.toString("utf8")));
    const workRoot = carrier.configuration.workRoot, part = relative(root, workRoot);
    need(part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part), "B5_INPUT_BINDING");
    const receipts = await ports.bindInputs({ entry: host.a2Entry, loopRunId: runId,
      stageDir: join(workRoot, `b5-supplied-${randomBytes(16).toString("hex")}`),
      files: { faultInput: config.faultInputFile, reviewInput: config.reviewInputFile }, digests, runWorkDir: projection.workDir, signal: workSignal });
    s = await status();
    need(!s.engine.confirmation && !s.display.confirmationCurrent && s.engine.state === "draft" && s.display.startState === "not_started"
      && receipts.every(receipt => receipt.input_version === s.engine.inputVersion), "B5_INPUT_BINDING_LATE");
    await write("input-bindings", receipts);
    await phase("bindings-ready", "phone", s); await phase("confirm-start", "phone", s);
    s = await status(); need(s.engine.confirmation && s.display.startState === "started" && bindingsReadyPublishedAt
      && Date.parse(s.engine.confirmation.at) >= Date.parse(bindingsReadyPublishedAt), "B5_CONFIRM_START_REQUIRED");
    await command("confirm", { inputVersion: s.engine.inputVersion, notBefore: bindingsReadyPublishedAt });
    await command("start", { inputVersion: s.engine.inputVersion, notBefore: bindingsReadyPublishedAt });
    await phase("close", "phone", s); await phase("close", "desktop", s);
    let questionSeen = false, planSeen = false, specSeen = false, auditAttempt = 0;
    const scanned = new Set<string>(), briefScanned = new Set<string>(), diagnosticHeads = new Set<string>();
    while (true) {
      workSignal.throwIfAborted(); s = await status();
      need(!["stopped", "refused"].includes(s.engine.state), "B5_ENGINE_REFUSED");
      const p = await readRun();
      const rawBytes = await readFirstWebsitePrivateBytesV1(join(root, "runs", runId, "run.json"), root);
      const raw = z.object({ steps: z.array(z.object({ n: z.number(), role: z.string(),
        report_snapshot: z.object({ path: z.string(), sha256: z.string() }).passthrough().optional() }).passthrough()) }).passthrough()
        .parse(parseStrictJsonV1(rawBytes.toString("utf8"), { maxBytes: 1 << 20 }));
      for (const step of p.steps.filter(step => step.role !== "build")) {
        const briefKey = b5Bytes(JSON.stringify([step.n, step.headAtStart, step.brief]));
        if (!briefScanned.has(briefKey)) {
          await writeFile(join(evidenceDir, `dispatch-${step.n}-${briefKey.slice(7)}.bin`), step.brief, { flag: "wx", mode: 0o600 });
          assertB5FaultTextAbsentV1(Buffer.from(step.brief), policy); briefScanned.add(briefKey);
        }
        if (!/^[a-f0-9]{40}$/u.test(step.headAtStart)) {
          need(!["code-review", "attack-review", "ui-review", "ci-review", "final"].includes(step.role), "B5_REVIEW_SCAN_INCOMPLETE");
          continue; // pre-candidate dispatch text was scanned; no invented head
        }
        const key = JSON.stringify([step.n, step.headAtStart, b5Bytes(step.brief)]);
        if (scanned.has(key)) continue;
        const surfaces = await readB5ReviewGitSurfacesV1(p.repository, host.proof.project.baseRevision, step.headAtStart);
        surfaces.push({ kind: "brief", name: `dispatch-${step.n}`, bytes: Buffer.from(step.brief) });
        for (const build of raw.steps.filter(b => b.role === "build" && b.n < step.n)) {
          need(build.report_snapshot, "B5_REVIEW_SCAN_INCOMPLETE");
          const report = await readFirstWebsitePrivateBytesV1(build.report_snapshot!.path, p.workDir);
          need(b5Bytes(report) === `sha256:${build.report_snapshot!.sha256}`, "B5_REVIEW_SCAN_CHANGED");
          surfaces.push({ kind: "builder-report", name: `build-${build.n}`, bytes: report });
        }
        const audit = await auditFirstWebsiteReviewV1({ root: evidenceDir, attempt: ++auditAttempt, head: step.headAtStart,
          dispatchDigest: b5Bytes(JSON.stringify([runId, step.n, step.inputVersion, step.startedAt, b5Bytes(step.brief)])),
          policy, expected: surfaces.map(({ kind, name }) => ({ kind, name })), surfaces });
        audits.push(audit); scanned.add(key);
      }
      for (const head of p.rejectedHeads) if (!diagnosticHeads.has(head)) {
        statusChecks.push(await ports.diagnosticSnapshot(p.repository, evidenceDir, head, "rejected")); diagnosticHeads.add(head);
      }
      const gate = s.decisions?.gate;
      if (gate?.kind === "question") {
        if (!questionSeen) { await restart(); restarts.push({phase:"waiting",at:new Date().toISOString()}); s = await status(); need(s.engine.question, "B5_QUESTION_RESTART"); }
        need(s.engine.question, "B5_QUESTION_RESTART");
        const question = s.engine.question;
        await phase("question", "phone", s);
        const after = await status();
        need(!after.engine.question || after.engine.question.questionId !== question.questionId, "B5_ANSWER_NOT_OBSERVED");
        await command("answer", { inputVersion: question.inputVersion, body: { questionId: question.questionId, questionReportSha256: question.reportSha256 },
          ...(!questionSeen ? { answer: "Amber" } : {}) });
        questionSeen = true;
      } else if (gate?.kind === "approve") {
        need(s.engine.approval, "B5_APPROVAL_REQUIRED");
        const approval = s.engine.approval, name = approval.step;
        await phase(name, "phone", s);
        const after = await waitB5ApprovalProgressV1({ approval, signal: workSignal, deadline: owner.workAt()!, read: status,
          accepted: descriptor => command("approve", { inputVersion: descriptor.inputVersion, body: descriptor }),
        });
        if (name === "plan") planSeen = true;
        else { specSeen = true; await phase("close", "phone", after); await phase("close", "desktop", after); }
      } else if (s.engine.state === "finished") {
        need(questionSeen && planSeen && specSeen && p.finalHead && p.cleanup?.state === "complete", "B5_JOURNEY_INCOMPLETE");
        assertRoleScopedBriefsV1(p.steps.map(step => ({ role: step.role, text: step.brief })), receipts);
        statusChecks.push(await ports.diagnosticSnapshot(p.repository, evidenceDir, p.finalHead, "final"));
        const cleanupAt=new Date().toISOString();
        await phase("repair", "phone", s); await phase("finish", "phone", s); await phase("finish", "desktop", s);
        await restart(); restarts.push({phase:"final",at:new Date().toISOString()}); s = await status(); await phase("retained", "phone", s);
        await write("controller-observations", { actions, observations, audits, snapshot: await host.proof.readSnapshot({ evidenceOnly: true }), statusChecks: statusChecks.map(check => check.record) });
        wroteObservations = true;
        const pins: B5QualifiedPinsV1 = { transportQualification:q, realEvidence: preflight.realEvidence, capture: preflight.capture, providers: preflight.providers, toolingRevision: config.a2.toolingRevision, schemaDigest: config.a2.schemaDigest,
          productBase: config.product.baseRevision, productHead: config.product.candidateRevision, uid: preflight.uid,
          digests: { settings: digests.settings!, availability: digests.availability!, authorization: digests.authorization!, qualification: digests.qualification!,
            assembly: digests.assembly!, faultInput: digests.faultInput!, reviewInput: digests.reviewInput! } };
        const snapshot=await host.proof.readSnapshot({evidenceOnly:true});
        let coldCard: import("../../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateCardV1 | undefined;
        verdict = await ports.verifyEvidence(evidenceDir, { candidateRepository: p.repository, pins,
          proofRoot: root, cleanupTargets: p.cleanup.targets.map(target => target.source),
          readCard: async () => {
            const value = await controllerSession.exchange(`${projectPath}/${encodeURIComponent(requestId!)}/candidate`, workSignal,
              undefined, readB5CandidateResponseV1) as Awaited<ReturnType<typeof readB5CandidateResponseV1>>;
            assertB5FaultValueAbsentV1(value, policy);
            const card = loopCandidateCardSchemaV1.parse(value.card);
            need(card.requestId === requestId && card.projectId === host!.proof.project.projectId && card.candidateRevision === p.finalHead
              && card.evidence.binding.runLinkId === s.request.runLink!.runLinkId, "B5_COLD_CARD_JOIN");
            coldCard=card; return value;
          }, finishTeardown: async () => {
            watching = false; await watcher; cleanupResult = await owner.cleanup(); await host!.close();
            need(coldCard,"B5_CARD_UNAVAILABLE");
            await writeFirstWebsiteControllerEvidenceV1({preflight,projection:p,actions,restarts,receipts,statusChecks,card:coldCard,
              cleanup:cleanupResult,owned:await host!.proof.inspectOwned(),snapshot,startedAt,cleanupAt});
          } });
        break;
      }
      await pause(workSignal);
    }
  } catch (error) {
    if (error instanceof Error) {
      const detail = { name: error.name, message: error.message, ...loopAdapterUnavailableDetailV1(error),
        ...(error instanceof B5RefusalV1 && error.code === "B5_A2_FINALIZATION_TIMEOUT"
          ? { finalizationReasonCode: loopFinalizationFailureReasonSchemaV1.catch("UNAVAILABLE").parse(error.detail) } : {}) };
      (verdict.detail ??= []).push(detail); observations.push({ phase: "controller-error", at: new Date().toISOString(), detail });
    }
    verdict = { ...verdict, state: "incomplete", reasons: [...new Set([workSignal.aborted ? codeOf(workSignal.reason) : codeOf(error), codeOf(error)])] };
  }
  finally {
    watching = false; await watcher;
    try {
      cleanupResult = await owner.cleanup();
      const late = await acquiring?.catch(() => undefined);
      host ??= late; await host?.close();
      if (host) {
        const owned = await host.proof.inspectOwned();
        need(owned.processCount === 0 && owned.listenerReleased && owned.postgresStopped && owned.runScratchAbsent, "B5_OWNED_CLEANUP_INCOMPLETE");
      }
    } catch (error) {
      if (error instanceof Error) {
        const detail = { name: error.name, message: error.message, ...loopAdapterUnavailableDetailV1(error) };
        (verdict.detail ??= []).push(detail); observations.push({ phase: "controller-cleanup-error", at: new Date().toISOString(), detail });
      }
      verdict.state = "incomplete"; verdict.reasons.push(codeOf(error));
    }
    finally { owner.dispose(); }
  }
  if (cleanupResult) {
    cleanupResult.overrunMs = owner.capAt() === undefined ? 0 : Math.max(0, Date.now() - owner.capAt()!);
    if (cleanupResult.overrunMs && !cleanupResult.failures.includes("B5_CLEANUP_OVERRUN")) cleanupResult.failures.push("B5_CLEANUP_OVERRUN");
    verdict.transportCleanup = cleanupResult;
    if (cleanupResult.failures.length || !cleanupResult.hostStopped || !cleanupResult.postgresStopped) {
      verdict.state = "incomplete"; verdict.reasons.push(...cleanupResult.failures);
    }
  }
  if (verdict.transportCleanup.disposition === "mapping-outstanding") {
    verdict.state = "incomplete"; verdict.reasons.push("B5_TRANSPORT_CLEANUP_INCOMPLETE");
  }
  if (preflight.providers?.transport === "scripted") {
    verdict.state = "incomplete"; verdict.reasons.push("B5_PROVIDER_FIXTURE");
  }
  verdict.reasons = [...new Set(verdict.reasons)];
  // Preflight can fail before the evidence directory exists. Retain its detail
  // through the same run-local writers after the shared cleanup.
  if (!wroteEvidence) try {
    await mkdir(evidenceDir, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    await chmod(evidenceDir, 0o700); wroteEvidence = true;
  } catch { verdict.state = "incomplete"; verdict.reasons.push("B5_VERDICT_WRITE_FAILED"); }
  if (wroteEvidence && !wroteObservations) try {
    await write("controller-observations", { actions, observations, audits, statusChecks: statusChecks.map(check => check.record) });
  } catch { verdict.state = "incomplete"; verdict.reasons.push("B5_OBSERVATIONS_WRITE_FAILED"); }
  if (verdict.reasons.some(reason => !["B5_PROVIDER_FIXTURE","B5_PHONE_EVIDENCE_MISSING","B5_DESKTOP_EVIDENCE_MISSING","B5_CAPTURE_MODE_UNAPPROVED"].includes(reason)))
    verdict.reasons = [...verdict.reasons.filter(reason => reason !== "B5_PROVIDER_FIXTURE"),
      ...verdict.reasons.filter(reason => reason === "B5_PROVIDER_FIXTURE")];
  if (wroteEvidence) try {
    await write("controller-timing", { schemaVersion: 1, startedAt, ...owner.timing(),
      ownerGateWaitExcluded: !preflight.rehearsal, workDeadline: owner.workAt(), cleanupDeadline: owner.capAt() });
    await write("controller-verdict", verdict);
  }
  catch { verdict.state = "incomplete"; verdict.reasons.push("B5_VERDICT_WRITE_FAILED"); }
  if (verdict.reasons.some(reason => !["B5_PROVIDER_FIXTURE","B5_PHONE_EVIDENCE_MISSING","B5_DESKTOP_EVIDENCE_MISSING","B5_CAPTURE_MODE_UNAPPROVED"].includes(reason)))
    verdict.reasons = [...verdict.reasons.filter(reason => reason !== "B5_PROVIDER_FIXTURE"),
      ...verdict.reasons.filter(reason => reason === "B5_PROVIDER_FIXTURE")];
  return verdict;
}

/** HTTP 202 also covers uncertain dispatch. The preparation barrier requires
 * positive intake acceptance before waiting for confirmation controls. */
export function assertB5AcceptedIntakeV1(value: unknown) {
  const receipt = loopBridgeReceiptSchemaV1.parse(value);
  need(receipt.state === "accepted", receipt.state === "refused" ? "B5_ENGINE_REFUSED" : "B5_INTAKE_UNCERTAIN");
  return receipt;
}

export const b5ControllerBrowserEventsSchemaV1 = b5DeviceServiceEvidenceSchemaV1;

/** Build evidence only from accepted mailbox receipts, successful browser
 * exchanges and the real engine projection. The caller finalizes it after its
 * authoritative cold read and the shared outer cleanup. No HTTP bodies persist. */
export async function writeFirstWebsiteControllerEvidenceV1(input: {
  preflight: FirstWebsitePreflightV1;
  projection: Awaited<ReturnType<FirstWebsiteHostV1["proof"]["readRun"]>>;
  actions: {receipt: import("./first-website-device").B5DeviceReceiptV1; browser?: z.infer<typeof b5ControllerBrowserEventsSchemaV1>}[];
  restarts: {phase:"waiting"|"final";at:string}[]; receipts: import("../../tests/helpers/improve-control-room-first-website").B5BindInputReceiptV1[];
  statusChecks: Awaited<ReturnType<typeof runIndependentStatusCheckV1>>[];
  card: import("../../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateCardV1;
  cleanup: B5ControllerCleanupV1; owned: import("../../tests/helpers/improve-control-room-first-website").FirstWebsiteOwnedV1;
  snapshot: Awaited<ReturnType<FirstWebsiteHostV1["proof"]["readSnapshot"]>>; startedAt: string; cleanupAt: string;
}) {
  const { preflight:p, projection:run, card, statusChecks, cleanup, owned } = input;
  const root=p.config.scratchRoot, dir=p.evidenceDir, b=card.evidence.binding;
  need(run.cleanup?.state === "complete" && run.finalHead === card.candidateRevision, "B5_JOURNEY_INCOMPLETE");
  const realSession=p.phoneTransport === "tailscale-serve";
  let realPins: import("../../tests/helpers/improve-control-room-first-website").B5RealEvidenceQualificationV1 | undefined;
  let transport: B5TransportQualificationV1 | undefined;
  if (realSession) {
    need(!p.rehearsal,"B5_REHEARSAL_PACKET_INVALID");
    const bytes=await readFirstWebsitePrivateBytesV1(p.config.a2.qualificationEvidence,root);
    need(b5Bytes(bytes) === p.digests.qualification,"B5_INPUT_CHANGED");
    const q=z.object({realEvidence:z.unknown(),rehearsal:z.unknown().optional()}).passthrough().parse(parseStrictJsonV1(bytes.toString("utf8")));
    need(q.rehearsal === undefined,"B5_REHEARSAL_PACKET_INVALID");
    realPins=qualifyB5RealEvidenceV1(q.realEvidence,p.config,p.digests);
    need(b5MappingDigestV1(realPins) === b5MappingDigestV1(p.realEvidence)
      && realPins.recipeDigest === b.recipeDigest && realPins.environmentDigest === b.environmentDigest,"B5_REAL_EVIDENCE_PINS");
    transport=await loadB5TransportV1(p.config.device.transportQualification,root,p.config.device.origin,p.digests.transport);
    for(const kind of ["phone","desktop"] as const)
      need(input.actions.some(a=>a.receipt.device === kind),kind === "phone" ? "B5_PHONE_EVIDENCE_MISSING" : "B5_DESKTOP_EVIDENCE_MISSING");
    for(const item of input.actions) {
      assertB5EvidenceSecretFreeV1(redactB5EvidenceV1(item,transport));
      need(item.receipt.real,"B5_DEVICE_REAL");
      const r=b5DeviceReceiptSchemaV1.safeParse(item.receipt);
      need(r.success,"B5_DEVICE_SCHEMA");
      const inventory=transport.inventory[item.receipt.device];
      need(item.receipt.origin === transport.origin && item.receipt.browser === `${inventory.browser}/${inventory.browserVersion}`,"B5_DEVICE_BROWSER");
      const browser=b5ControllerBrowserEventsSchemaV1.safeParse(item.browser);
      need(browser.success && browser.data.sequence === item.receipt.sequence,"B5_BROWSER_EVIDENCE_MISSING");
      need(browser.data.events.every(e=>e.responseDigest),"B5_ACTION_EVIDENCE");
    }
  } else need(p.rehearsal && p.providers.transport === "scripted","B5_REHEARSAL_PACKET_INVALID");

  const saved = new Map<string,string>();
  const save = async (path:string, bytes:Uint8Array|string) => {
    if (transport && path.endsWith(".json")) {
      const value=redactB5EvidenceV1(parseStrictJsonV1(Buffer.from(bytes).toString("utf8")),transport);
      assertB5EvidenceSecretFreeV1(value);
      bytes=JSON.stringify(value)+"\n";
    }
    need(/^[a-z0-9][a-z0-9./-]{0,255}$/u.test(path) && !path.includes("..") && Buffer.byteLength(bytes)<=1<<20,"B5_ARTIFACT_BYTES");
    if(saved.has(path)) { need(saved.get(path) === b5Bytes(bytes),"B5_ARTIFACT_BYTES"); return; }
    saved.set(path,b5Bytes(bytes));
    await mkdir(dirname(join(dir,path)),{recursive:true,mode:0o700});
    await writeFile(join(dir,path),bytes,{flag:"wx",mode:0o600});
  };
  const json = (path:string,value:unknown)=>save(path,JSON.stringify(value)+"\n");
  const actions: z.infer<typeof b5JourneySchemaV1>["actions"] = [], serviceFacts: z.infer<typeof b5JourneySchemaV1>["serviceFacts"] = [], dom: z.infer<typeof b5JourneySchemaV1>["dom"] = [];
  const closed: z.infer<typeof b5JourneySchemaV1>["closed"] = [];
  let closePair: typeof input.actions = [];
  for (const item of input.actions) {
    const r=item.receipt, receiptPath=`mailbox/receipts/${r.sequence}.json`;
    const receiptBytes=await readFirstWebsitePrivateBytesV1(join(root,"device/receipts",`${r.sequence}.json`),root).catch(error=>{
      if(realSession) throw new B5RefusalV1(r.device === "phone" ? "B5_PHONE_EVIDENCE_MISSING" : "B5_DESKTOP_EVIDENCE_MISSING");
      throw error;
    });
    if(realSession) {
      const original=parseStrictJsonV1(receiptBytes.toString("utf8")); assertB5EvidenceSecretFreeV1(redactB5EvidenceV1(original,transport!));
      // A changed in-memory capture digest must fail correlation before any
      // stale receipt can be mistaken for accepted evidence.
      for(const c of r.captures) need(b5Bytes(await readFirstWebsitePrivateBytesV1(join(root,"device",c.path),root)) === c.sha256,"B5_CAPTURE_CORRELATION");
      need(b5MappingDigestV1(original) === b5MappingDigestV1(r),"B5_DEVICE_RECEIPT_CHANGED");
      const observation=await readFirstWebsitePrivateBytesV1(join(root,"device/observations",`${r.sequence}.json`),root);
      need(b5MappingDigestV1(parseStrictJsonV1(observation.toString("utf8"))) === b5MappingDigestV1(r.observation),"B5_CAPTURE_CORRELATION");
      await save(`mailbox/observations/${r.sequence}.json`,observation);
      const serviceBytes=await readFirstWebsitePrivateBytesV1(join(root,"device/service",`${r.sequence}.json`),root);
      const server=b5DeviceServiceEvidenceSchemaV1.safeParse(parseStrictJsonV1(serviceBytes.toString("utf8")));
      need(server.success && !server.data.dom && b5MappingDigestV1(server.data.events) === b5MappingDigestV1(item.browser?.events),"B5_DEVICE_SERVICE_CHANGED");
    }
    await save(receiptPath,receiptBytes);
    if(item.browser) await json(`mailbox/service/${r.sequence}.json`,item.browser);
    for (const c of r.captures) {
      const bytes=await readFirstWebsitePrivateBytesV1(join(root,"device",c.path),root);
      need(b5Bytes(bytes) === c.sha256,"B5_CAPTURE_CORRELATION"); await save(`mailbox/${c.path}`,bytes);
    }
    const browser=item.browser;
    need(browser && browser.sequence === r.sequence,"B5_BROWSER_EVIDENCE_MISSING");
    for(const event of browser.events) {
      need(event.status>=200 && event.status<300,"B5_ACTION_EVIDENCE");
      const {name,at,method,path,status}=event;
      actions.push({name,at,method,path,status,sequence:r.sequence,device:r.device,receiptPath,
        requestId:card.requestId,runLinkId:b.runLinkId,localVersion:card.localVersion,inputVersion:card.a2InputVersion});
      if (["finish-phone","finish-desktop","retained"].includes(name)) {
        const screen=name === "finish-phone" ? "07-finish-phone" : name === "finish-desktop" ? "08-finish-desktop" : "09-retained";
        need(event.recordDigest === card.recordDigest && event.candidateRevision === card.candidateRevision && event.baseRevision === b.baseRevision,"B5_COLD_CARD_JOIN");
        const capture=r.captures[0]!, capturePath=`screens/${screen}.png`, responseReceiptPath=`responses/${r.sequence}.json`;
        await save(capturePath,await readFirstWebsitePrivateBytesV1(join(root,"device",capture.path),root));
        await json(responseReceiptPath,{responseDigest:event.responseDigest,recordDigest:event.recordDigest,requestId:card.requestId,candidateRevision:card.candidateRevision,at});
        serviceFacts.push({screen,device:r.device,sequence:r.sequence,at,requestId:card.requestId,runLinkId:b.runLinkId,localVersion:card.localVersion,
          inputVersion:card.a2InputVersion,candidateRevision:card.candidateRevision,baseRevision:b.baseRevision,responseDigest:event.responseDigest!,responseReceiptPath,
          captureSourcePath:capture.path,capturePath,captureDigest:capture.sha256,receiptPath});
        if(r.device === "desktop") { need(browser.dom,"B5_HEAD_BINDING"); dom.push({screen,...browser.dom}); }
      }
    }
    const screen = ({prepare:"01-prepare","confirm-start":"02-confirm-start",question:"03-question",plan:"04-plan",spec:"05-spec",repair:"06-repair"} as Record<string,string>)[r.phase];
    if(screen) await save(`screens/${screen}.png`,await readFirstWebsitePrivateBytesV1(join(root,"device",r.captures[0]!.path),root));
    if(r.phase === "close") closePair.push(item);
    else if(closePair.length) {
      need(closePair.length === 2,"B5_ACTION_EVIDENCE");
      closed.push({label:`closed-${closed.length+1}`,from:closePair.map(c=>c.receipt.observedAt).sort().at(-1)!,to:r.observation.observedAt,
        receipts:closePair.map(c=>({device:c.receipt.device,sequence:c.receipt.sequence,path:`mailbox/receipts/${c.receipt.sequence}.json`}))});
      closePair=[];
    }
  }
  const raw = z.object({steps:z.array(z.object({n:z.number(),role:z.string(),log:z.string(),grade:z.string().optional(),report_snapshot:z.object({path:z.string(),sha256:z.string()}).passthrough().optional(),
    sidecar_seals:z.array(z.object({path:z.string(),sha256:z.string()}).passthrough()).optional()}).passthrough()),
    chain:z.object({consumed_results:z.array(z.object({step:z.number(),verdict:z.string()}).passthrough())}).passthrough()}).passthrough()
    .parse(JSON.parse((await readFirstWebsitePrivateBytesV1(join(root,"runs",b.loopRunId,"run.json"),root)).toString("utf8")));
  const roster=(await readFirstWebsitePrivateBytesV1(join(root,"tools/loop/models.tsv"),root)).toString("utf8").trimEnd().split(/\r?\n/u);
  const columns=roster.shift()!.split("\t");need(columns.includes("name") && columns.includes("family"),"B5_PROVIDER_PROVENANCE_MISMATCH");
  const families=new Map<string,string>();
  for(const line of roster.filter(line=>line && !line.startsWith("#"))) {
    const fields=line.split("\t"),name=fields[columns.indexOf("name")]!,family=fields[columns.indexOf("family")]!;
    need(name && family && !families.has(name),"B5_PROVIDER_PROVENANCE_MISMATCH");families.set(name,family);
  }
  const steps: z.infer<typeof b5JourneySchemaV1>["steps"] = [];
  for (const [i,s] of run.steps.entries()) {
    // QUESTION-only dispatches have no terminal completed report; their gate,
    // answer and restart are recorded separately, never invented as DONE.
    const verdict=s.verdict ?? raw.chain.consumed_results.find(r=>r.step === s.n)?.verdict;
    if(!s.endedAt || !verdict || !["DONE","CLEAN","NEEDS-FIX"].includes(verdict)) continue;
    const review=card.evidence.reviews.find(r=>r.stepId === `step-${s.n}`);
    const source=raw.steps.find(x=>x.n === s.n); need(source?.report_snapshot,"B5_REVIEW_SCAN_INCOMPLETE");
    const metadata=z.object({served_model:z.string().optional(),served_route:z.object({family:z.string()}).passthrough().optional(),
      receipts:z.array(z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)})).min(1)}).passthrough().safeParse(s.modelIdentity);
    need(metadata.success,"B5_PROVIDER_PROVENANCE_MISMATCH");
    const nativeReceipts=[];
    for(const seal of metadata.data.receipts) {
      const bytes=await readFirstWebsitePrivateBytesV1(seal.path,root);
      need(b5Bytes(bytes) === `sha256:${seal.sha256}`,"B5_PROVIDER_PROVENANCE_MISMATCH");
      const receipt=z.object({attempt:z.number().int().positive(),launcher:z.string().min(1),requested_model:z.string(),resolved_model:z.string().min(1),state:z.string(),log:z.string()}).passthrough().parse(JSON.parse(bytes.toString("utf8")));
      need(receipt.requested_model === s.requestedModel && receipt.log === source.log,"B5_PROVIDER_PROVENANCE_MISMATCH");nativeReceipts.push(receipt);
    }
    const native=nativeReceipts.sort((a,b)=>a.attempt-b.attempt).at(-1)!;
    const identity=native.resolved_model,route=native.launcher,grade=source.grade ?? "not-applicable";
    const family=metadata.data.served_route?.family ?? families.get(identity);
    const slot=p.providers.lineup.find(q=>q.role === s.role && q.identity === identity);
    need(native.state === "COMPLETE" && (!metadata.data.served_model || metadata.data.served_model === identity)
      && family && slot && slot.family === family && slot.route === route && slot.grade === grade
      && (!["plan","spec","build","fix"].includes(s.role) || source.grade !== undefined)
      && (!review || review.family === family && (review.selectedModel ?? review.observedModel) === identity),"B5_PROVIDER_PROVENANCE_MISMATCH");
    const report=await readFirstWebsitePrivateBytesV1(source.report_snapshot.path,run.workDir);
    need(b5Bytes(report) === `sha256:${source.report_snapshot.sha256}`,"B5_REVIEW_SCAN_CHANGED");
    let diagnostic:"FAIL"|"PASS"|null=null;
    if(s.role === "code-review") {
      const seal=source.sidecar_seals?.[0]; need(seal,"B5_REVIEW_SCAN_INCOMPLETE");
      const bytes=await readFirstWebsitePrivateBytesV1(seal.path,run.workDir);
      need(b5Bytes(bytes) === `sha256:${seal.sha256}`,"B5_REVIEW_SCAN_CHANGED");
      const sidecar=z.object({checks:z.array(z.object({id:z.string(),status:z.string()}).passthrough())}).passthrough().parse(JSON.parse(bytes.toString("utf8")));
      const check=sidecar.checks.find(c=>c.id === "site-status"); need(check && ["PASS","FAIL"].includes(check.status),"B5_DIAGNOSTIC_RESULT");
      diagnostic=check.status as "PASS"|"FAIL";
    }
    const head=s.role === "build" ? run.steps[i+1]?.headAtStart : s.headAtStart;
    need(head && /^[a-f0-9]{40}$/u.test(head),"B5_HEAD_BINDING");
    steps.push({n:s.n,role:s.role,identity,family,verified:review?.identityVerified ?? false,identityBasis:"selected",head,
      provider:{transport:p.providers.transport,admittedIdentity:identity,route,grade},startedAt:s.startedAt,endedAt:s.endedAt,
      verdict:verdict as "DONE"|"CLEAN"|"NEEDS-FIX",diagnostic,
      findings:(s.findings ?? []).map(f=>{const v=z.object({severity:z.enum(["HIGH","MEDIUM","LOW"]),disposition:z.string()}).passthrough().parse(f);
        return {severity:v.severity,state:v.disposition === "OPEN" ? "open" as const : "fixed" as const,summary:"Details in retained review report"};})});
  }
  const journey=b5JourneySchemaV1.parse({schemaVersion:1,phoneCapture:p.capture.phoneCapture,captureQualificationDigest:p.capture.qualificationDigest,
    restarts:input.restarts,actions,serviceFacts,closed,steps,dom,devices:["phone","desktop"].map(kind=>({kind,real:input.actions.filter(a=>a.receipt.device === kind).every(a=>a.receipt.real),browser:input.actions.find(a=>a.receipt.device === kind)!.receipt.browser}))});
  await json("journey.json",journey);
  await json("database-snapshot.json",input.snapshot); await json("independent-status-check.json",statusChecks.map(c=>c.record));
  const retained=actions.find(a=>a.name === "retained"); need(retained,"B5_ACTION_EVIDENCE");
  let retainedCleanup=cleanup;
  if(realSession) {
    await json("transport/qualification.json",retainB5TransportQualificationV1(transport!,p.capture.qualificationDigest));
    for(const name of ["removal-request","removal-receipt"])
      await save(`transport/${name}.json`,await readFirstWebsitePrivateBytesV1(join(root,"device",`${name}.json`),root));
    const removal=parseStrictJsonV1((await readFirstWebsitePrivateBytesV1(join(root,"device/removal-receipt.json"),root)).toString("utf8"));
    retainedCleanup={...cleanup,removalReceiptDigest:b5MappingDigestV1(redactB5EvidenceV1(removal,transport!))};
  }
  const jobSandboxDigest=realPins?.jobSandboxDigest ?? p.rehearsal!.jobSandboxDigest;
  return finalizeFirstWebsiteEvidenceV1(dir,{
    schemaVersion:1,kind:"b5-first-website-proof",product:{baseRevision:p.config.product.baseRevision,headRevision:p.config.product.candidateRevision,environmentDigest:b.environmentDigest},
    pins:{a2ToolingRevision:p.config.a2.toolingRevision,schemaDigest:p.config.a2.schemaDigest,jobSandboxDigest,
      qualificationDigest:p.digests.qualification!,recipeDigest:b.recipeDigest,settingsSha256:p.digests.settings!,availabilitySha256:p.digests.availability!,
      faultInputSha256:p.digests.faultInput!,reviewInputSha256:p.digests.reviewInput!,authorizationSha256:p.digests.authorization!,assemblyDigest:p.digests.assembly!,assemblyExport:"createFirstWebsiteHostV1",
      inputBindings:input.receipts.map(r=>({name:r.name as "b5-builder-fault"|"b5-review-instruction",roles:r.roles,sha256:`sha256:${r.sha256}`,path:r.path,revision:r.revision,at:new Date(r.at).toISOString(),receiptDigest:b5Bytes(JSON.stringify(r))}))},
    risk:{categories:p.settings.riskCategories,slots:p.settings.riskSlots},launch:{uid:p.uid,context:"current-session",isolationClaim:"none",consumedRoots:["config","runs","work"]},
    lineage:{requestId:card.requestId,runLinkId:b.runLinkId,loopRunId:b.loopRunId,localVersion:card.localVersion,a2InputVersion:card.a2InputVersion},
    heads:{base:b.baseRevision,rejected:run.rejectedHeads[0]!,final:card.candidateRevision},
    classification:{website:"real",storage:"real",engine:"real",sendBack:"real",recovery:"real",finish:"real",providers:p.providers.classification,device:transport && journey.devices.every(d=>d.real) ? "real" : "fixture",stimuli:"fixture"},
    timestamps:{startedAt:input.startedAt,finishedAt:new Date().toISOString()},
  }, {schemaVersion:1,b3cCleanup:"complete",scratchAbsent:owned.runScratchAbsent,ownedProcesses:owned.processCount,ownedListenersReleased:owned.listenerReleased,
    protectedListenersUntouched:true,postgresStopped:owned.postgresStopped,cleanupAt:input.cleanupAt,
    retainedRead:{at:retained.at,candidateRevision:card.candidateRevision,receiptDigest:card.recordDigest},transportCleanup:retainedCleanup},
  {proofRoot:root,candidateRepository:run.repository,cleanupTargets:run.cleanup.targets.map(t=>t.source)});
}

/** B is independent of engine intake. The tools helper owns launcher groups and
 * reaps them before returning; interruption cannot cancel that safety close. */
export async function runFirstWebsiteProviderDenialsV1(preflight:FirstWebsitePreflightV1, signal:AbortSignal, owner:B5ControllerOwnerV1) {
  const p=preflight.rehearsal; need(p && preflight.providers.transport === "scripted","B5_REHEARSAL_PACKET_INVALID");
  const root=p.root;
  need((await readdir(join(root,"runs"))).length === 0,"B5_REHEARSAL_ROOT_USED");
  need(!await import("node:fs/promises").then(fs=>fs.lstat(join(root,"config/b5-run-binding.json")).then(()=>true,e=>{if(e.code === "ENOENT")return false;throw e;})),"B5_REHEARSAL_ROOT_USED");
  // Validate the source manifest, interpreter bytes, carrier callables, build
  // and bind-input capability before executing even a denial probe. This is
  // read-only qualification, with no PG, listener, intake or model launch.
  const {entry}=await (await import("./first-website-host")).validateFirstWebsiteHostV1(preflight.config,owner);
  signal.throwIfAborted();
  const configuration=JSON.parse((await readFirstWebsitePrivateBytesV1(join(root,"config/b5-provider.json"),root)).toString("utf8"));
  need(configuration.python === entry.interpreter,"B5_HOST_INTERPRETER_PIN");
  for(const route of ["codex-job","claude-job","marvin-job"]) {
    signal.throwIfAborted();
    const name=`b5-real-exec-denial-${route}.json`,trace=join(preflight.evidenceDir,name);
    const result=await exec(entry.interpreter,["-I","-B",join(root,"tools/loop/bridge/b5-provider.py"),"denial-probe",root,join(root,"config/b5-provider.json"),route,trace],
      {cwd:root,env:{NODE_ENV:"test",PATH:"/usr/bin:/bin",HOME:join(root,"home-work"),TMPDIR:join(root,"tmp"),TZ:"UTC",LANG:"C"},timeout:125_000,maxBuffer:1<<20});
    need(result.stdout.includes("B5_REAL_LAUNCH_ATTEMPTED B5_REAL_LAUNCH_DENIED"),"B5_DENIAL_NOT_PROVEN");
    const record=JSON.parse((await readFirstWebsitePrivateBytesV1(trace,root)).toString("utf8"));
    need(record.marker === "B5_REAL_LAUNCH_DENIED" && record.markers?.includes("B5_REAL_LAUNCH_ATTEMPTED")
      && record.route === route && [1,13].includes(record.errno) && record.childExit !== 0 && record.providers === "fixture"
      && record.nativeReceiptSha256?.length && record.nativeCleanup === "closed provider custody; ended launcher"
      && JSON.stringify(record.target) === JSON.stringify(configuration.probes[route].target),"B5_DENIAL_NOT_PROVEN");
    // The native helper verifies the pinned target bytes before attempting
    // exec, including targets larger than the evidence reader's 1 MiB cap.
  }
  const unsupported: {route:string;exitCode:number;marker:string}[]=[];
  for(const route of ["nvidia-job","opencode-job","ollama-job"]) {
    signal.throwIfAborted();
    const denied=await exec(entry.interpreter,["-I","-B",join(root,"lead/bin/launch-router.py"),route],
      {cwd:root,env:{NODE_ENV:"test",PATH:"/usr/bin:/bin",HOME:join(root,"home-work"),TMPDIR:join(root,"tmp"),TZ:"UTC"},timeout:10_000,maxBuffer:65536})
      .then(()=>({code:0,stderr:""}),error=>({code:error.code,stderr:error.stderr}));
    need(denied.code === 2 && denied.stderr.trim() === "B5_FIXTURE_ROUTE_DENIED","B5_DENIAL_NOT_PROVEN");
    unsupported.push({route,exitCode:2,marker:"B5_FIXTURE_ROUTE_DENIED"});
  }
  await writeFile(join(preflight.evidenceDir,"b5-unsupported-routes.json"),JSON.stringify(unsupported)+"\n",{flag:"wx",mode:0o600});
  signal.throwIfAborted();
}
