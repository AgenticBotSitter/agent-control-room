// Proof-only foreground controller. Imports are inert. Engine commands go
// through the product website; role input binding uses the qualified A2 entry.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  B5RefusalV1, B5_MAX_DURATION_MS, B5_REQUEST_TEXT, b5Bytes, type B5VerdictV1, type FirstWebsiteCleanupOwnerV1,
  loadFirstWebsiteAssemblyV1, probeBindInputCapabilityV1, bindFirstWebsiteInputsV1, assertRoleScopedBriefsV1,
  b5FaultScanPolicySchemaV1, normalizeB5FaultTextV1, assertB5FaultTextAbsentV1, assertB5FaultValueAbsentV1, auditFirstWebsiteReviewV1, readB5ReviewGitSurfacesV1,
  readFirstWebsitePrivateBytesV1, runIndependentStatusCheckV1, verifyFirstWebsiteEvidenceV1, assertFirstWebsiteOwnerCommandV1,
  type B5QualifiedPinsV1,
  type FirstWebsitePreflightV1, type FirstWebsiteHostV1,
} from "../../tests/helpers/improve-control-room-first-website";
import {
  B5DeviceRefusalV1, createB5DeviceCleanupV1, type B5TransportQualificationV1,
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
import { loopDecisionStatusSchemaV1, type LoopDecisionStatusV1 } from "../../src/web/v1/improve-control-room-loop-attention-wire";
import { loopCandidateCardSchemaV1 } from "../../src/improve-control-room/v1/loop-candidate-wire";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { parseStrictJsonV1 } from "../../src/installer/shared/strict-json.mjs";
const exec = promisify(execFile);
const need: (v: unknown, code: string) => asserts v = (v, code) => { if (!v) throw new B5RefusalV1(code); };

export type B5ControllerCleanupV1 = {
  disposition: "mapping-not-created" | "mapping-removed" | "mapping-outstanding";
  mappingAttempted: boolean; mappingUncertain: boolean; comparison: boolean | null;
  beforeDigest: string | null; installedDigest: string | null; afterDigest: string | null;
  removalReceiptDigest: string | null; hostStopped: boolean; postgresStopped: boolean;
  failures: string[]; overrunMs: number;
};
const codeOf = (error: unknown) => error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_CONTROLLER_FAILED";
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
  const interrupt = () => abort.abort(new B5RefusalV1("B5_INTERRUPTED"));
  const forwarded = () => abort.abort(external?.reason ?? new B5RefusalV1("B5_ABORTED"));
  // Both listeners are present before the PG helper may skip its protection.
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  external?.addEventListener("abort", forwarded, { once: true });
  if (external?.aborted) forwarded();
  const onAbort = () => { void cleanup().catch(() => {}); };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  function cleanup() {
    return closing ??= Promise.resolve().then(async () => {
      clearTimeout(timer);
      const result: B5ControllerCleanupV1 = { disposition: mapping ? "mapping-outstanding" : "mapping-not-created",
        mappingAttempted: !!mapping, mappingUncertain: uncertain, comparison: null,
        beforeDigest: mapping?.qualification.beforeDigest ?? qualifiedTransport?.beforeDigest ?? null, installedDigest: mapping?.qualification.installedDigest ?? null,
        afterDigest: null, removalReceiptDigest: null, hostStopped: false, postgresStopped: false, failures: [], overrunMs: 0 };
      if (stopWork) try { await bounded(stopWork, 30_000, "B5_STOP_TIMEOUT"); } catch (error) { result.failures.push(error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_STOP_FAILED"); }
      const close = async () => {
        const failures = await Promise.allSettled([Promise.resolve().then(() => closeHost?.()), ...resources.map(f => Promise.resolve().then(f))]);
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
      result.overrunMs = capAt === undefined ? 0 : Math.max(0, Date.now() - capAt);
      if (result.overrunMs) result.failures.push("B5_CLEANUP_OVERRUN");
      return result;
    });
  }
  const owner: Omit<FirstWebsiteCleanupOwnerV1, "cleanup" | "registerStopPostgres"> & {
    registerStopPostgres(stop: () => Promise<void>): void;
    signal: AbortSignal; cleanup: typeof cleanup; abort(reason: B5RefusalV1): void;
    beginAcquisition(): void; capAt(): number | undefined; workAt(): number | undefined;
    startDeadline(ms: number): void; registerResource(close: () => Promise<void>): void;
    registerStopWork(stop: (signal: AbortSignal) => Promise<void>): void;
    qualifyTransport(q: B5TransportQualificationV1): void;
    armMapping(q: B5TransportQualificationV1, removal: NonNullable<typeof mapping>["requestRemoval"]): void;
    mappingInstalled(): void; dispose(): void;
  } = {
    signal: abort.signal, cleanup, abort: reason => abort.abort(reason), beginAcquisition() { acquisitionStarted = true; }, capAt: () => capAt, workAt: () => workAt,
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
    startDeadline(ms) {
      if (timer || !Number.isSafeInteger(ms) || ms < 1 || ms > B5_MAX_DURATION_MS) throw new B5RefusalV1("B5_DEADLINE_INVALID");
      abort.signal.throwIfAborted();
      const reserve = Math.min(300_000, Math.floor(ms / 2)); capAt = Date.now() + ms; workAt = capAt - reserve;
      timer = setTimeout(() => abort.abort(new B5RefusalV1("B5_DEADLINE")), ms - reserve);
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

async function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>(yes => {
    const timer = setTimeout(done, 1000);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); yes(); }
    signal.addEventListener("abort", done, { once: true });
  });
  signal.throwIfAborted();
}

/** Actual current-time local-owner HTTP reads. Cookies stay in memory and are
 * revoked after each exchange. There is no saved browser state or principal. */
async function exchange(host: FirstWebsiteHostV1, path: string, signal: AbortSignal, body?: unknown) {
  return host.proof.withOwnerCode(async ownerCode => {
    const localSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const issued = await fetch(host.origin + "/api/v1/local-owner-session", { method: "POST", redirect: "error", signal: localSignal,
      headers: { origin: host.origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
    need(issued.status === 201, "B5_CONTROLLER_SESSION");
    const cookie = issued.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; ");
    need(cookie.length > 0, "B5_CONTROLLER_SESSION");
    try {
      const response = await fetch(host.origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", signal: localSignal,
        headers: { origin: host.origin, cookie, accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": `b5-stop-${randomBytes(16).toString("hex")}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      need(response.ok, "B5_CONTROLLER_SERVICE");
      return await readBrowserJson(response, 1 << 20, 10_000);
    } finally {
      const signedOut = await fetch(host.origin + "/api/v1/local-owner-session", { method: "DELETE", redirect: "error",
        headers: { origin: host.origin, cookie }, signal: AbortSignal.timeout(10_000) });
      need(signedOut.status === 204, "B5_CONTROLLER_SESSION_CLEANUP");
    }
  });
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
  const directory = join(root, `diagnostic-${label}-${head}`);
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
}) {
  input.signal.throwIfAborted();
  const request = await input.mailbox.request(input.phase, input.device, input.expiresAt, input.binding);
  input.onPublished?.();
  assertB5FaultValueAbsentV1(request, input.policy);
  const receipt = await waitB5DeviceJsonV1(join(input.mailbox.root, "inbox", `${request.sequence}.json`), input.mailbox.root, input.signal, Date.parse(input.expiresAt));
  assertB5FaultValueAbsentV1(receipt, input.policy);
  const accepted = await input.mailbox.accept(receipt);
  // Binary frames still need the lead's visual check under the capture
  // contract. It does not define a second per-phase acknowledgement mailbox.
  return { receipt: accepted };
}

/** Foreground F04a driver. It collects actual observations and delegates the
 * final publication/provenance verdict to the retained-evidence verifier.
 * No fixture identity, mailbox assertion or manifest can substitute for it. */
export async function runFirstWebsiteJourneyV1(preflight: FirstWebsitePreflightV1, signal: AbortSignal): Promise<B5VerdictV1> {
  const owner = preflight.controllerOwner ?? createFirstWebsiteControllerOwnerV1(signal);
  const { config, evidenceDir, digests } = preflight, root = config.scratchRoot;
  let host: FirstWebsiteHostV1 | undefined, acquiring: Promise<FirstWebsiteHostV1> | undefined;
  let verdict: B5VerdictV1 = { state: "incomplete", reasons: [] }, requestId: string | undefined, bindingsReadyPublishedAt: string | undefined;
  let wroteEvidence = false, wroteObservations = false, watching = true;
  let watcher: Promise<void> | undefined;
  const workSignal = owner.signal;
  const statusChecks: Awaited<ReturnType<typeof runIndependentStatusCheckV1>>[] = [];
  const actions: unknown[] = [], observations: unknown[] = [], audits: unknown[] = [];
  let cleanupResult: B5ControllerCleanupV1 | undefined;
  const write = async (name: string, value: unknown) => {
    need(/^[a-z][a-z0-9-]*$/u.test(name), "B5_CONTROLLER_EVIDENCE_PATH");
    const bytes = Buffer.from(JSON.stringify(value) + "\n"); need(bytes.length <= 1 << 20, "B5_CONTROLLER_EVIDENCE_SIZE");
    await writeFile(join(evidenceDir, `${name}.json`), bytes, { flag: "wx", mode: 0o600 });
  };
  try {
    owner.startDeadline(config.maxDurationMs); workSignal.throwIfAborted();
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
    need(preflight.phoneTransport === "tailscale-serve", "B5_DEVICE_QUALIFICATION_REQUIRED");
    const q = await loadB5TransportV1(config.device.transportQualification, root, config.device.origin, digests.transport);
    owner.qualifyTransport(q);
    await mkdir(evidenceDir, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    await chmod(evidenceDir, 0o700); wroteEvidence = true;
    await write("controller-start", { schemaVersion: 1, startedAt: new Date().toISOString(), preflightDigests: digests,
      mappingAttempted: false, captureMode: q.captureMode, phoneDomAvailable: false, binaryScan: "lead-visual-check-required" });
    const create = await loadFirstWebsiteAssemblyV1(config); workSignal.throwIfAborted();
    owner.beginAcquisition();
    acquiring = create(config, workSignal, { signalOwner: owner });
    host = await acquiring; workSignal.throwIfAborted();
    need(host.startup.isReady() && host.proof.device, "B5_HOST_NOT_READY");
    await probeBindInputCapabilityV1(host.a2Entry, workSignal); workSignal.throwIfAborted(); // before ANY intake invitation
    const mailbox = host.proof.device, deviceRoot = mailbox.root;
    await ownerChannel(host, root, owner);
    const projectPath = `/api/v1/projects/${encodeURIComponent(host.proof.project.projectId)}/improvements/loop`;
    const service = async (path: string, body?: unknown, activeSignal = workSignal) => {
      const value = await exchange(host!, path, activeSignal, body);
      assertB5FaultValueAbsentV1(value, policy); return value;
    };
    let previousObservation: string | undefined;
    const status = async (activeSignal = workSignal) => {
      need(requestId, "B5_REQUEST_JOIN");
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
    watcher = (async () => {
      while (watching && !workSignal.aborted) {
        if (!requestId) {
          const desk = loopImprovementDeskViewSchemaV1.parse(await service(projectPath + "/desk"));
          need(desk.loopRequests.length <= 1, "B5_REQUEST_JOIN");
          if (desk.loopRequests.length) { need(desk.loopRequests[0].description === B5_REQUEST_TEXT, "B5_REQUEST_JOIN"); requestId = desk.loopRequests[0].requestId; }
        }
        if (requestId) {
          const current = await status();
          if (current.engine.state === "stopped") owner.abort(new B5RefusalV1("B5_OWNER_STOP"));
          if (current.engine.state === "refused") owner.abort(new B5RefusalV1("B5_ENGINE_REFUSED"));
          if (!bindingsReadyPublishedAt && (current.engine.confirmation || current.display.startState !== "not_started"))
            owner.abort(new B5RefusalV1("B5_INPUT_BINDING_LATE"));
        }
        await pause(workSignal);
      }
    })().catch(error => { if (watching && !workSignal.aborted) owner.abort(new B5RefusalV1(codeOf(error))); });
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
      const result = await runFirstWebsiteDevicePhaseV1({ mailbox, phase: name, device, binding, signal: workSignal, policy,
        expiresAt: new Date(Math.min(owner.workAt()!, Date.parse(q.expiresAt))).toISOString(),
        onPublished() { if (name === "bindings-ready") bindingsReadyPublishedAt = new Date().toISOString(); } });
      actions.push(result); return result.receipt;
    };
    // Arm ownership BEFORE publishing an owner install request. An interrupted
    // or uncertain command still requires cancellation, reconciliation/removal.
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
    const installed = await waitB5DeviceJsonV1(join(deviceRoot, "install-receipt.json"), deviceRoot, workSignal, Date.now() + 120_000) as Record<string, unknown>;
    need(installed.schemaVersion === 1 && installed.actor === "owner" && installed.installNonce === installNonce
      && installed.command === B5_DEVICE_INSTALL_COMMAND_V1 && installed.statusCommand === B5_DEVICE_STATUS_COMMAND_V1
      && installed.exitCode === 0 && installed.statusExitCode === 0 && typeof installed.observedAt === "string"
      && Date.parse(installed.observedAt) >= Date.parse(requestedAt) && Date.parse(installed.observedAt) <= Date.now()
      && installed.statusDigest === q.installedDigest && b5MappingDigestV1(installed.status) === q.installedDigest, "B5_DEVICE_INSTALL_RECEIPT");
    owner.mappingInstalled();
    await phase("connect", "phone"); await phase("connect", "desktop"); await phase("prepare", "phone");
    const desk = loopImprovementDeskViewSchemaV1.parse(await service(projectPath + "/desk"));
    need(desk.loopRequests.length === 1 && desk.loopRequests[0].description === B5_REQUEST_TEXT && desk.loopRequests[0].runLink, "B5_REQUEST_JOIN");
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
    const readRun = async () => {
      while (true) try { workSignal.throwIfAborted(); return await host!.proof.readRun(runId); }
      catch (error) {
        if (!(error instanceof Error) || !["B5_A2_CHANGED", "B5_A2_REVISION"].includes(error.message)) throw error;
        await pause(workSignal); // retry a read spanning an actual engine revision
      }
    };
    const projection = await readRun();
    const carrierBytes = await readFirstWebsitePrivateBytesV1(config.a2.contractFile, root);
    need(b5Bytes(carrierBytes) === digests.contract, "B5_INPUT_CHANGED");
    const carrier = z.object({ configuration: z.object({ workRoot: z.string() }).passthrough() }).passthrough().parse(parseStrictJsonV1(carrierBytes.toString("utf8")));
    const workRoot = carrier.configuration.workRoot, part = relative(root, workRoot);
    need(part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part), "B5_INPUT_BINDING");
    const receipts = await bindFirstWebsiteInputsV1({ entry: host.a2Entry, loopRunId: runId,
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
        statusChecks.push(await diagnosticSnapshot(p.repository, evidenceDir, head, "rejected")); diagnosticHeads.add(head);
      }
      const gate = s.decisions?.gate;
      if (gate?.kind === "question") {
        if (!questionSeen) { await host.proof.restart(workSignal); s = await status(); need(s.engine.question, "B5_QUESTION_RESTART"); }
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
        const name = s.engine.approval.step; await phase(name, "phone", s);
        const after = await status();
        need(!after.engine.approval || JSON.stringify(after.engine.approval) !== JSON.stringify(s.engine.approval), "B5_APPROVAL_NOT_OBSERVED");
        await command("approve", { inputVersion: s.engine.approval.inputVersion, body: s.engine.approval });
        if (name === "plan") planSeen = true;
        else { specSeen = true; await phase("close", "phone", after); await phase("close", "desktop", after); }
      } else if (s.engine.state === "finished") {
        need(questionSeen && planSeen && specSeen && p.finalHead && p.cleanup?.state === "complete", "B5_JOURNEY_INCOMPLETE");
        assertRoleScopedBriefsV1(p.steps.map(step => ({ role: step.role, text: step.brief })), receipts);
        statusChecks.push(await diagnosticSnapshot(p.repository, evidenceDir, p.finalHead, "final"));
        await phase("repair", "phone", s); await phase("finish", "phone", s); await phase("finish", "desktop", s);
        await host.proof.restart(workSignal); s = await status(); await phase("retained", "phone", s);
        await write("controller-observations", { actions, observations, audits, snapshot: await host.proof.readSnapshot(), statusChecks: statusChecks.map(check => check.record) });
        wroteObservations = true;
        const pins: B5QualifiedPinsV1 = { toolingRevision: config.a2.toolingRevision, schemaDigest: config.a2.schemaDigest,
          productBase: config.product.baseRevision, productHead: config.product.candidateRevision, uid: preflight.uid,
          digests: { settings: digests.settings!, availability: digests.availability!, authorization: digests.authorization!, qualification: digests.qualification!,
            assembly: digests.assembly!, faultInput: digests.faultInput!, reviewInput: digests.reviewInput! } };
        verdict = await verifyFirstWebsiteEvidenceV1(evidenceDir, { candidateRepository: p.repository, pins,
          readCard: async () => {
            const value = await service(`${projectPath}/${encodeURIComponent(requestId!)}/candidate`) as { candidate?: unknown };
            const card = loopCandidateCardSchemaV1.parse(value.candidate);
            need(card.requestId === requestId && card.projectId === host!.proof.project.projectId && card.candidateRevision === p.finalHead
              && card.evidence.binding.runLinkId === s.request.runLink!.runLinkId, "B5_COLD_CARD_JOIN");
            return card;
          }, finishTeardown: async () => { watching = false; await watcher; cleanupResult = await owner.cleanup(); await host!.close(); } });
        break;
      }
      await pause(workSignal);
    }
  } catch (error) { verdict = { state: "incomplete", reasons: [...new Set([workSignal.aborted ? codeOf(workSignal.reason) : codeOf(error), codeOf(error)])] }; }
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
    } catch (error) { verdict.state = "incomplete"; verdict.reasons.push(codeOf(error)); }
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
  verdict.reasons = [...new Set(verdict.reasons)];
  if (wroteEvidence && !wroteObservations) try {
    await write("controller-observations", { actions, observations, audits, statusChecks: statusChecks.map(check => check.record) });
  } catch { verdict.state = "incomplete"; verdict.reasons.push("B5_OBSERVATIONS_WRITE_FAILED"); }
  if (wroteEvidence) try { await write("controller-verdict", verdict); }
  catch { verdict.state = "incomplete"; verdict.reasons.push("B5_VERDICT_WRITE_FAILED"); }
  return verdict;
}
