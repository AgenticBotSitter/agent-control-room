import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { captureFleetConnectorReleaseManifestV1, type FleetConnectorReleaseAdvertisementV1,
  type FleetConnectorReleaseManifestV1 } from "./connector-release";
import { isIP } from "node:net";
import type { WorkBatchServiceV1 } from "../../work-intake/v1/service";
import { WorkIntakeErrorV1 } from "../../work-intake/v1/errors";
import { FleetErrorV1, fleetFail, type FleetErrorCodeV1 } from "./errors";
import type { FleetGatewayStoreV1, FleetWorkerPrincipalV1 } from "./gateway-store";
import { FLEET_DIGEST_PATTERN_V1, FLEET_PROJECT_ID_PATTERN_V1, FLEET_WORKER_ID_PATTERN_V1,
  plainSha256V1 } from "./identifiers";
import { captureReleaseTrustV1, type ReleaseTrustV1 } from "../../../scripts/release-signing.mjs";
import { FleetWaitAbortedErrorV1, FleetWaitCapacityErrorV1, FleetWaitRegistryV1 } from "./wait-registry";

/**
 * The S1 proposal service reports its designed refusals with its own safe
 * codes. They are refusals, not failures: a bot that reuses one idempotency key
 * for different work must be told `conflict`, and a credential the intake login
 * will not act for must be told `forbidden`, exactly as every other fleet
 * refusal is. Without this translation they escape as an untyped 400 and the
 * gateway's own operator log records a perfectly ordinary client mistake as a
 * server fault. `integrity_failed` is deliberately absent: it is never a client
 * error and must keep reaching the operator log.
 *
 * A null-prototype map, so a lookup can never find `Object.prototype` and treat
 * an inherited member as a refusal code.
 */
const WORK_INTAKE_REFUSALS_V1: Readonly<Record<string, FleetErrorCodeV1>> = Object.assign(
  Object.create(null) as Record<string, FleetErrorCodeV1>, Object.freeze({
    credential_inactive: "forbidden",
    no_matching_grant: "forbidden",
    replay_conflict: "conflict",
    batch_not_found: "not_found",
    invalid_input: "invalid",
  }));

/**
 * The connector-facing API. Every route except enrollment and the connector
 * download authenticates the machine credential BEFORE a body byte is read.
 * There is deliberately no route that approves, accepts, merges, assigns or
 * changes permissions; those are owner actions on the web path only.
 */
export const FLEET_BODY_LIMITS_V1 = Object.freeze({ enroll: 4 * 1024, small: 32 * 1024,
  proposal: 256 * 1024, result: 1_700_000, chunk: 8 * 1024 * 1024 + 4096, upload: 16 * 1024 });
const headers = Object.freeze({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer" });
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type AdmissionKindV1 = "enroll" | "authenticate";
type AdmissionStateV1 = { startedAt: number; count: number; touchedAt: number };
export type FleetGatewayTrustedClientHeaderV1 = "cf-connecting-ip" | "x-forwarded-for-rightmost" | "none";
export type FleetGatewayAdmissionLeaseV1 = Readonly<{
  /** Releases a request that stopped before authentication completed. */
  release(): void;
  /** Settles an authentication attempt into exactly one isolated budget. */
  completeAuthentication(authenticatedWorkerId: string | null): void;
}>;
export type FleetGatewayAdmissionV1 = Readonly<{
  /** Records only a server-verified digest, never a bearer secret. */
  registerCredential(authenticatedWorkerId: string, credentialDigest: string): void;
  enter(request: IncomingMessage, kind: AdmissionKindV1): FleetGatewayAdmissionLeaseV1;
}>;
export type FleetGatewayAdmissionOptionsV1 = Readonly<{ clock?: () => number; windowMs?: number;
  enrollPerIp?: number; enrollGlobal?: number; authenticatePerIp?: number; authenticateGlobal?: number;
  enrollPerIpv6_48?: number; authenticatePerIpv6_48?: number;
  authenticatedPerWorker?: number; authenticatedGlobal?: number;
  maxConcurrent?: number; maxConcurrentEnroll?: number; maxConcurrentKnown?: number;
  maxConcurrentKnownPerWorker?: number; maxTrackedIps?: number; maxTrackedWorkers?: number;
  trustedProxyAddresses?: readonly string[]; trustedClientHeader?: FleetGatewayTrustedClientHeaderV1 }>;

function ipv6Words(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  const embedded = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address)?.[1];
  if (embedded) {
    const octets = embedded.split(".").map(Number);
    address = `${address.slice(0, -embedded.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${
      ((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const wordStrings = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (wordStrings.length !== 8) return undefined;
  return wordStrings.map(word => Number.parseInt(word, 16));
}

function normalizedAddress(value: string | undefined) {
  if (!value) return "unknown";
  const trimmed = value.trim().toLowerCase();
  if (isIP(trimmed) === 4) return trimmed;
  const words = ipv6Words(trimmed);
  if (!words) return "unknown";
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff)
    return `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`;
  return trimmed;
}

function ipv6Network64(address: string) {
  const words = ipv6Words(address)!;
  return `${words.slice(0, 4).map(word => word.toString(16)).join(":")}::/64`;
}

function ipv6Network48(address: string) {
  const words = ipv6Words(address)!;
  return `${words.slice(0, 3).map(word => word.toString(16)).join(":")}::/48`;
}

/** Coarsens unauthenticated source identities so address rotation within one
 * ordinary client network cannot manufacture fresh budgets. */
export function fleetGatewayClientNetworkV1(address: string) {
  const normalized = normalizedAddress(address);
  if (isIP(normalized) === 4) return `${normalized.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIP(normalized) === 6) return ipv6Network64(normalized);
  return "unknown";
}

/** Forwarded identity is an operator-selected contract with an exact immediate
 * proxy address. With the default `none`, even loopback-supplied headers are
 * ignored. Only one header syntax is ever accepted. */
export function fleetGatewayClientAddressV1(request: IncomingMessage,
  options: Pick<FleetGatewayAdmissionOptionsV1, "trustedProxyAddresses" | "trustedClientHeader"> = {}) {
  const peer = normalizedAddress(request.socket.remoteAddress);
  const selected = options.trustedClientHeader ?? "none";
  const trusted = new Set((options.trustedProxyAddresses ?? []).map(normalizedAddress));
  if (selected === "none" || !trusted.has(peer)) return peer;
  const forwarded = selected === "cf-connecting-ip" ? header(request, "cf-connecting-ip")
    : header(request, "x-forwarded-for")?.split(",").at(-1)?.trim();
  const candidate = normalizedAddress(forwarded);
  return candidate === "unknown" ? peer : candidate;
}

export function createFleetGatewayAdmissionV1(options: FleetGatewayAdmissionOptionsV1 = {}): FleetGatewayAdmissionV1 {
  const clock = options.clock ?? Date.now, windowMs = options.windowMs ?? 60_000;
  const perIp = { enroll: options.enrollPerIp ?? 8, authenticate: options.authenticatePerIp ?? 120 };
  const perIpv6_48 = { enroll: options.enrollPerIpv6_48 ?? perIp.enroll * 3,
    authenticate: options.authenticatePerIpv6_48 ?? perIp.authenticate * 3 };
  const globalLimit = { enroll: options.enrollGlobal ?? 80, authenticate: options.authenticateGlobal ?? 1_000 };
  const authenticatedPerWorker = options.authenticatedPerWorker ?? 120;
  const authenticatedGlobal = options.authenticatedGlobal ?? 1_000;
  const maxConcurrent = options.maxConcurrent ?? 16, maxTrackedIps = options.maxTrackedIps ?? 4_096;
  const maxConcurrentEnroll = options.maxConcurrentEnroll ?? Math.min(4, maxConcurrent);
  const maxConcurrentKnown = options.maxConcurrentKnown ?? maxConcurrent;
  const maxConcurrentKnownPerWorker = options.maxConcurrentKnownPerWorker ?? Math.min(4, maxConcurrentKnown);
  const maxTrackedWorkers = options.maxTrackedWorkers ?? 4_096;
  if (![windowMs, perIp.enroll, perIp.authenticate, perIpv6_48.enroll, perIpv6_48.authenticate,
    globalLimit.enroll, globalLimit.authenticate, authenticatedPerWorker, authenticatedGlobal, maxConcurrent,
    maxConcurrentEnroll, maxConcurrentKnown, maxConcurrentKnownPerWorker, maxTrackedIps, maxTrackedWorkers]
    .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("fleet_admission_invalid");
  const selectedHeader = options.trustedClientHeader ?? "none";
  const trustedProxies = options.trustedProxyAddresses ?? [];
  if (!(["cf-connecting-ip", "x-forwarded-for-rightmost", "none"] as const).includes(selectedHeader)
    || trustedProxies.some(address => normalizedAddress(address) === "unknown")
    || selectedHeader !== "none" && trustedProxies.length === 0) throw new Error("fleet_admission_invalid");
  const sources = new Map<string, AdmissionStateV1>(), workers = new Map<string, AdmissionStateV1>();
  const credentials = new Map<string, string>();
  const global = {
    enroll: { startedAt: 0, count: 0, touchedAt: 0 },
    authenticate: { startedAt: 0, count: 0, touchedAt: 0 },
    authenticated: { startedAt: 0, count: 0, touchedAt: 0 },
  };
  const active = { enroll: 0, authenticate: 0, known: 0 };
  const activeKnownWorkers = new Map<string, number>();
  type ChargeV1 = { state: AdmissionStateV1; window: number };
  const refresh = (state: AdmissionStateV1, now: number) => {
    if (now < state.startedAt || now - state.startedAt >= windowMs) { state.startedAt = now; state.count = 0; }
    state.touchedAt = now;
  };
  const tick = (state: AdmissionStateV1, now: number, limit: number) => {
    refresh(state, now);
    if (state.count >= limit) return false;
    state.count += 1;
    return true;
  };
  const stateFor = (map: Map<string, AdmissionStateV1>, key: string, now: number, maximum: number) => {
    let state = map.get(key);
    if (state) return state;
    for (const [candidate, value] of map) if (now - value.touchedAt >= windowMs) map.delete(candidate);
    if (map.size >= maximum) return fleetFail("rate_limited");
    state = { startedAt: now, count: 0, touchedAt: now };
    map.set(key, state);
    return state;
  };
  const refund = (charges: readonly ChargeV1[]) => {
    for (const charge of charges) if (charge.state.startedAt === charge.window && charge.state.count > 0)
      charge.state.count -= 1;
  };
  const charge = (budgets: readonly { state: AdmissionStateV1; limit: number }[], now: number) => {
    const charges: ChargeV1[] = [];
    for (const budget of budgets) {
      if (!tick(budget.state, now, budget.limit)) { refund(charges); return undefined; }
      charges.push({ state: budget.state, window: budget.state.startedAt });
    }
    return charges;
  };
  const sourceBudgets = (kind: AdmissionKindV1, address: string, network: string, now: number) => {
    const budgets = [{ state: stateFor(sources, `${kind}:${network}`, now, maxTrackedIps), limit: perIp[kind] }];
    if (isIP(address) === 6) budgets.push({
      state: stateFor(sources, `${kind}:${ipv6Network48(address)}`, now, maxTrackedIps), limit: perIpv6_48[kind],
    });
    budgets.push({ state: global[kind], limit: globalLimit[kind] });
    return budgets;
  };
  return Object.freeze({
    registerCredential(authenticatedWorkerId: string, credentialDigest: string) {
      if (!FLEET_WORKER_ID_PATTERN_V1.test(authenticatedWorkerId) || !FLEET_DIGEST_PATTERN_V1.test(credentialDigest))
        throw new Error("fleet_admission_invalid");
      credentials.set(authenticatedWorkerId, credentialDigest);
    },
    enter(request: IncomingMessage, kind: AdmissionKindV1) {
      const now = clock();
      if (!Number.isSafeInteger(now)) return fleetFail("unavailable");
      const address = fleetGatewayClientAddressV1(request, options);
      const network = fleetGatewayClientNetworkV1(address);
      const authorization = header(request, "authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const declaredWorkerId = header(request, "x-control-room-worker");
      const presentedDigest = bearer === undefined ? undefined : plainSha256V1(bearer);
      const knownCredential = kind === "authenticate" && declaredWorkerId !== undefined && presentedDigest !== undefined
        && credentials.get(declaredWorkerId) === presentedDigest;
      let provisionalCharges: readonly ChargeV1[] | undefined;
      let lane: keyof typeof active;
      if (kind === "enroll") {
        lane = "enroll";
        if (active.enroll >= maxConcurrentEnroll) return fleetFail("rate_limited");
        if (!charge(sourceBudgets(kind, address, network, now), now)) return fleetFail("rate_limited");
      } else if (knownCredential && declaredWorkerId !== undefined) {
        lane = "known";
        const worker = stateFor(workers, declaredWorkerId, now, maxTrackedWorkers);
        refresh(worker, now); refresh(global.authenticated, now);
        if (worker.count >= authenticatedPerWorker || global.authenticated.count >= authenticatedGlobal
          || active.known >= maxConcurrentKnown
          || (activeKnownWorkers.get(declaredWorkerId) ?? 0) >= maxConcurrentKnownPerWorker)
          return fleetFail("rate_limited");
      } else {
        lane = "authenticate";
        if (active.authenticate >= maxConcurrent) return fleetFail("rate_limited");
        provisionalCharges = charge(sourceBudgets(kind, address, network, now), now);
        if (!provisionalCharges) return fleetFail("rate_limited");
      }
      active[lane] += 1;
      if (lane === "known" && declaredWorkerId !== undefined)
        activeKnownWorkers.set(declaredWorkerId, (activeKnownWorkers.get(declaredWorkerId) ?? 0) + 1);
      let settled = false;
      const refundProvisionalFailure = () => {
        if (!provisionalCharges) return;
        refund(provisionalCharges);
        provisionalCharges = undefined;
      };
      const settle = () => {
        if (settled) return false;
        settled = true;
        active[lane] -= 1;
        if (lane === "known" && declaredWorkerId !== undefined) {
          const remaining = (activeKnownWorkers.get(declaredWorkerId) ?? 1) - 1;
          if (remaining === 0) activeKnownWorkers.delete(declaredWorkerId);
          else activeKnownWorkers.set(declaredWorkerId, remaining);
        }
        return true;
      };
      return Object.freeze({
        release() { if (settle()) refundProvisionalFailure(); },
        completeAuthentication(authenticatedWorkerId: string | null) {
          if (!settle()) return;
          if (kind !== "authenticate") return fleetFail("unavailable");
          if (authenticatedWorkerId !== null) {
            refundProvisionalFailure();
            if (presentedDigest !== undefined) credentials.set(authenticatedWorkerId, presentedDigest);
            const state = stateFor(workers, authenticatedWorkerId, now, maxTrackedWorkers);
            if (!tick(state, now, authenticatedPerWorker) || !tick(global.authenticated, now, authenticatedGlobal))
              return fleetFail("rate_limited");
            return;
          }
          if (knownCredential && declaredWorkerId !== undefined) credentials.delete(declaredWorkerId);
          if (provisionalCharges) return;
          // Failed credentials alone spend this lane. They can neither charge
          // nor occupy the independently tracked authenticated-worker reserve.
          if (!charge(sourceBudgets("authenticate", address, network, now), now)) return fleetFail("rate_limited");
        },
      });
    },
  });
}

function send(response: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}) {
  response.writeHead(status, { ...headers, ...extraHeaders, connection: "close" });
  response.end(JSON.stringify(body));
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = header(request, "content-length");
  if (declared !== undefined && (!/^\d{1,9}$/u.test(declared) || Number(declared) > limit)) fleetFail("too_large");
  if (!(header(request, "content-type") ?? "").startsWith("application/json")) fleetFail("invalid");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      length += bytes.length;
      if (length > limit) fleetFail("too_large");
      chunks.push(bytes);
    }
  } catch (error) {
    if (request.aborted) return fleetFail("invalid");
    throw error;
  }
  return Buffer.concat(chunks, length).toString("utf8");
}
function object(raw: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fleetFail("invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fleetFail("invalid");
  const actual = Object.keys(parsed);
  if (keys.some(key => !actual.includes(key)) || actual.some(key => !keys.includes(key) && !optional.includes(key)))
    return fleetFail("invalid");
  return parsed as Record<string, unknown>;
}
/**
 * A raw chunk body, with its own content type and no JSON framing.
 *
 * The chunk is the one body in this protocol that is not JSON, because
 * base64-encoding 8 MiB would cost a third more bytes on the wire and a third
 * more memory on both ends for no benefit: the chunk's digest is carried in a
 * header, which is also what makes a retry's comparison exact. The length is
 * bounded by the same limit the `content-length` check below uses, so a
 * declared length is never trusted over the bytes actually read.
 */
async function readChunkBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = header(request, "content-length");
  if (declared !== undefined && (!/^\d{1,9}$/u.test(declared) || Number(declared) > limit)) fleetFail("too_large");
  if ((header(request, "content-type") ?? "") !== "application/octet-stream") fleetFail("invalid");
  const digest = header(request, "x-control-room-chunk-digest");
  if (digest === undefined || !FLEET_DIGEST_PATTERN_V1.test(digest)) fleetFail("invalid");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      length += bytes.length;
      if (length > limit) fleetFail("too_large");
      chunks.push(bytes);
    }
  } catch (error) {
    if (request.aborted) return fleetFail("invalid");
    throw error;
  }
  if (!length) return fleetFail("invalid");
  return new Uint8Array(Buffer.concat(chunks, length));
}
function decodeFiles(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fleetFail("invalid");
  if (value.length > 8) return fleetFail("too_large");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fleetFail("invalid");
    const file = item as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "contentBase64,mediaType,name" || typeof file.contentBase64 !== "string"
      || !base64Pattern.test(file.contentBase64)) return fleetFail("invalid");
    if (file.contentBase64.length > Math.ceil(262_144 / 3) * 4) return fleetFail("too_large");
    return { name: file.name, mediaType: file.mediaType, content: new Uint8Array(Buffer.from(file.contentBase64, "base64")) };
  });
}

export type FleetGatewayHttpOptionsV1 = Readonly<{ store: FleetGatewayStoreV1; proposals?: WorkBatchServiceV1;
  connectorRelease?: Readonly<{ bundle: Uint8Array; manifest: FleetConnectorReleaseManifestV1; manifestBody: string;
    advertisement: FleetConnectorReleaseAdvertisementV1 }>;
  releaseTrust: ReleaseTrustV1;
  /** The upload ingress. Absent means this gateway has no byte store, and the
   * upload routes answer 503 rather than pretending the claim has no outputs. */
  uploads?: FleetUploadServiceV1;
  now?: () => string;
  admission?: FleetGatewayAdmissionV1;
  waitRegistry?: FleetWaitRegistryV1;
  /** Operator log for failures that are not a fixed refusal. Never sent to the caller. */
  onUnexpectedError?: (error: unknown) => void }>;

/** The slice of the upload store the HTTP layer uses. Declared here rather than
 * as the concrete class so a test can supply a narrow fake, and so the route
 * layer is forced to name the five verbs the connector may call — there is no
 * sixth, and no way to reach the store's internals from a request. */
export interface FleetUploadServiceV1 {
  declaredOutputs(principal: FleetWorkerPrincipalV1, claimId: unknown): Promise<unknown>;
  reserve(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; ordinal: unknown;
    sizeBytes: unknown; contentDigest: unknown; mediaType?: unknown }>): Promise<unknown>;
  chunk(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; uploadId: unknown;
    ordinal: unknown; bytes: unknown }>): Promise<unknown>;
  finalise(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; uploadId: unknown;
    publish?: unknown }>): Promise<unknown>;
  voidUpload(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; uploadId: unknown;
    reason?: unknown }>): Promise<unknown>;
  inputs(principal: FleetWorkerPrincipalV1, claimId: unknown): Promise<unknown>;
  inputBytes(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; ordinal: unknown }>):
    Promise<{ ordinal: number; displayName: string; contentDigest: string; sizeBytes: number; bytes: Uint8Array }>;
}

export function createFleetGatewayHandlerV1(options: FleetGatewayHttpOptionsV1) {
  const now = options.now ?? (() => new Date().toISOString());
  const admission = options.admission ?? createFleetGatewayAdmissionV1();
  const waitRegistry = options.waitRegistry ?? new FleetWaitRegistryV1();
  let connectorRelease = options.connectorRelease;
  const releaseTrust = captureReleaseTrustV1(options.releaseTrust);
  if (connectorRelease) {
    let manifest: FleetConnectorReleaseManifestV1, declared: FleetConnectorReleaseManifestV1;
    try {
      manifest = captureFleetConnectorReleaseManifestV1(JSON.parse(connectorRelease.manifestBody));
      declared = captureFleetConnectorReleaseManifestV1(connectorRelease.manifest);
    }
    catch { throw new Error("fleet_connector_release_refused"); }
    if (JSON.stringify(manifest) !== JSON.stringify(declared)
      || connectorRelease.bundle.length !== manifest.size
      || createHash("sha256").update(connectorRelease.bundle).digest("hex") !== manifest.sha256
      || connectorRelease.advertisement.version !== manifest.version
      || connectorRelease.advertisement.file !== manifest.file
      || connectorRelease.advertisement.sha256 !== manifest.sha256
      || connectorRelease.advertisement.size !== manifest.size
      || connectorRelease.advertisement.builtFrom !== manifest.builtFrom)
      throw new Error("fleet_connector_release_refused");
    connectorRelease = Object.freeze({ bundle: connectorRelease.bundle, manifest, manifestBody: connectorRelease.manifestBody,
      advertisement: connectorRelease.advertisement });
  }
  const claimRoute = /^\/fleet\/v1\/claims\/(fleet-claim:[a-f0-9]{32})\/(progress|blocker|result)$/u;
  const proposalRoute = /^\/fleet\/v1\/projects\/([^/]+)\/proposals$/u;
  // The upload routes hang off the claim, because an upload IS a claim's
  // promise: the claim id is the authority, and everything else is a name
  // inside it. `inputs` is the one GET, and it is the combine part's own.
  const uploadRoute = /^\/fleet\/v1\/claims\/(fleet-claim:[a-f0-9]{32})\/(outputs|inputs|reserve|finalise|void)$/u;
  const chunkRoute = /^\/fleet\/v1\/claims\/(fleet-claim:[a-f0-9]{32})\/uploads\/(result-upload:[a-f0-9]{32})\/chunks$/u;
  const inputBytesRoute = /^\/fleet\/v1\/claims\/(fleet-claim:[a-f0-9]{32})\/inputs\/(\d{1,2})$/u;
  const databaseUnavailable = (error: unknown) => !(error instanceof FleetErrorV1) && error instanceof Error
    && (error.message === "database_unavailable" || (error as Error & { code?: unknown }).code === "database_unavailable");

  async function authenticated(request: IncomingMessage): Promise<FleetWorkerPrincipalV1> {
    const lease = admission.enter(request, "authenticate");
    try {
      const authorization = header(request, "authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const principal = await options.store.authenticate({ bearer, declaredWorkerId: header(request, "x-control-room-worker") });
      lease.completeAuthentication(principal.workerId);
      return principal;
    } catch (error) {
      if (error instanceof FleetErrorV1 && error.code === "unauthenticated") {
        // A spent failure budget must not replace the authentication refusal;
        // the MCP route still needs the original error to record its audit.
        try { lease.completeAuthentication(null); }
        catch (chargeError) {
          if (!(chargeError instanceof FleetErrorV1 && chargeError.code === "rate_limited"))
            options.onUnexpectedError?.(chargeError);
        }
      }
      else lease.release();
      throw error;
    }
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://gateway.invalid"); } catch { return fleetFail("not_found"); }
    if (url.search || url.hash) return fleetFail("not_found");
    const path = url.pathname, method = request.method;
    const release = connectorRelease;
    if (method === "GET" && release && (path === "/fleet/v1/connector.mjs"
      || path === `/fleet/v1/${release.manifest.file}`)) {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8",
        "content-length": String(release.manifest.size), "x-content-type-options": "nosniff",
        "x-control-room-connector-sha256": `sha256:${release.manifest.sha256}`,
        connection: "close" });
      response.end(release.bundle);
      return;
    }
    if (method === "GET" && path === "/fleet/v1/connector-manifest.json" && release) {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(release.manifestBody)), "x-content-type-options": "nosniff",
        connection: "close" });
      response.end(release.manifestBody);
      return;
    }
    if (method === "POST" && path === "/fleet/v1/enroll") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.enroll),
        ["code", "workerKind", "credentialDigest", "platform", "architecture", "connectorVersion", "clientNonce"], ["adapterCapabilities"]);
      const lease = admission.enter(request, "enroll");
      try {
        const result = await options.store.enroll(body as never);
        admission.registerCredential(result.workerId, body.credentialDigest as string);
        return send(response, result.replayed ? 200 : 201, { ok: true,
          result: { ...result, releaseTrust, ...(release ? { connector: release.advertisement } : {}) } });
      } finally { lease.release(); }
    }
    // Every other route: authenticate first, then read the body.
    const releaseRoute = /^\/fleet\/v1\/connector-releases\/(\d+\.\d+\.\d+)$/u.exec(path);
    const known = path === "/fleet/v1/me" || path === "/fleet/v1/heartbeat" || path === "/fleet/v1/rotate"
      || path === "/fleet/v1/work" || path === "/fleet/v1/work/wait" || path === "/fleet/v1/claims" || path === "/fleet/v1/mcp/calls"
      || releaseRoute !== null || claimRoute.test(path) || proposalRoute.test(path) || uploadRoute.test(path)
      || chunkRoute.test(path) || inputBytesRoute.test(path);
    if (!known) return fleetFail("not_found");
    let principal: FleetWorkerPrincipalV1;
    try { principal = await authenticated(request); }
    catch (error) {
      if (path === "/fleet/v1/mcp/calls" && error instanceof FleetErrorV1 && error.code === "unauthenticated") {
        const authorization = header(request, "authorization");
        await options.store.recordRefusedMcpAuthentication({
          bearer: authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
          declaredWorkerId: header(request, "x-control-room-worker"),
          callId: header(request, "x-control-room-mcp-call"), toolName: header(request, "x-control-room-mcp-tool"),
        });
      }
      throw error;
    }
    if (method === "GET" && releaseRoute && release && releaseRoute[1] === release.manifest.version) {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8",
        "content-length": String(release.manifest.size), "x-content-type-options": "nosniff", connection: "close" });
      response.end(release.bundle); return;
    }
    if (method === "GET" && path === "/fleet/v1/me") return send(response, 200, { ok: true,
      result: { ...options.store.me(principal), releaseTrust, ...(release ? { connector: release.advertisement } : {}) } });
    if (method === "GET" && path === "/fleet/v1/work") return send(response, 200, { ok: true, result: await options.store.listWork(principal) });
    if (method === "GET" && path === "/fleet/v1/work/wait") {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort); response.once("close", abort);
      if (request.destroyed || response.destroyed || request.socket.destroyed) abort();
      try {
        const result = await waitRegistry.wait(principal.workerId, () => options.store.waitWork(principal), controller.signal,
          () => options.store.recordWaitPresence(principal));
        if (!controller.signal.aborted && !response.destroyed)
          return send(response, 200, { ok: true, result });
        return;
      } catch (error) {
        if (error instanceof FleetWaitAbortedErrorV1) return;
        if (error instanceof FleetWaitCapacityErrorV1)
          return send(response, 429, { ok: false, error: "rate_limited" },
            { "retry-after": String(error.retryAfterSeconds) });
        if (error instanceof FleetErrorV1) throw error;
        options.onUnexpectedError?.(error);
        return send(response, 503, { ok: false, error: "unavailable" },
          { "retry-after": "1" });
      } finally {
        request.off("aborted", abort); response.off("close", abort);
      }
    }
    if (method === "GET" && path === "/fleet/v1/claims") return send(response, 200, { ok: true, result: await options.store.myClaims(principal) });

    // --- the upload path ------------------------------------------------
    // A gateway with no byte store answers 503 on every one of these, rather
    // than 404: the route exists, the installation is just not wired for it,
    // and a connector that sees 404 would go looking for another way in.
    if (uploadRoute.test(path) || chunkRoute.test(path) || inputBytesRoute.test(path)) {
      if (!options.uploads) return fleetFail("unavailable");
    }
    const upload = uploadRoute.exec(path);
    if (upload) {
      const [, claimId, action] = upload as unknown as [string, string, string];
      if (method === "GET" && action === "outputs")
        return send(response, 200, { ok: true, result: await options.uploads!.declaredOutputs(principal, claimId) });
      if (method === "GET" && action === "inputs")
        return send(response, 200, { ok: true, result: await options.uploads!.inputs(principal, claimId) });
      if (method !== "POST") return fleetFail("not_found");
      if (action === "reserve") {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.upload),
          ["ordinal", "sizeBytes", "contentDigest"], ["mediaType"]);
        const result = await options.uploads!.reserve(principal, { ...body, claimId } as never);
        return send(response, 201, { ok: true, result });
      }
      if (action === "finalise") {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["uploadId"], ["publish"]);
        if (typeof body.uploadId !== "string" || !/^result-upload:[a-f0-9]{32}$/u.test(body.uploadId))
          return fleetFail("invalid");
        const result = await options.uploads!.finalise(principal, { ...body, claimId } as never);
        return send(response, 200, { ok: true, result });
      }
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["uploadId"], ["reason"]);
      if (typeof body.uploadId !== "string" || !/^result-upload:[a-f0-9]{32}$/u.test(body.uploadId))
        return fleetFail("invalid");
      return send(response, 200, { ok: true, result: await options.uploads!.voidUpload(principal,
        { ...body, claimId } as never) });
    }
    const inputBytes = inputBytesRoute.exec(path);
    if (inputBytes) {
      if (method !== "GET") return fleetFail("not_found");
      // The one response in this protocol that is not JSON: the bytes of one
      // declared input, with its digest in a header so a connector can prove
      // what it received rather than trusting the length. Attachment-only and
      // `application/octet-stream`, because these bytes are the other machine's
      // output and are never rendered on this origin.
      const payload = await options.uploads!.inputBytes(principal, { claimId: inputBytes[1]!,
        ordinal: Number(inputBytes[2]!) });
      response.writeHead(200, { ...headers, "content-type": "application/octet-stream",
        "content-length": String(payload.bytes.byteLength),
        "x-control-room-content-digest": payload.contentDigest,
        "content-disposition": "attachment", connection: "close" });
      response.end(Buffer.from(payload.bytes));
      return;
    }
    const chunk = chunkRoute.exec(path);
    if (chunk) {
      if (method !== "POST") return fleetFail("not_found");
      const [, claimId, uploadId] = chunk as unknown as [string, string, string];
      // The ordinal rides in a header, because this body is raw bytes and a
      // JSON envelope around an 8 MiB chunk would mean buffering it twice. The
      // header is validated here so a missing or non-numeric ordinal is refused
      // before the body is read at all.
      const ordinal = Number(header(request, "x-control-room-chunk-ordinal"));
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 32) return fleetFail("invalid");
      const bytes = await readChunkBody(request, FLEET_BODY_LIMITS_V1.chunk);
      const result = await options.uploads!.chunk(principal, { claimId, uploadId, ordinal, bytes });
      return send(response, 201, { ok: true, result });
    }

    if (method !== "POST") return fleetFail("not_found");
    if (path === "/fleet/v1/mcp/calls") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["callId", "toolName"]);
      return send(response, 201, { ok: true, result: await options.store.recordMcpCall(principal, body as never) });
    }
    if (path === "/fleet/v1/heartbeat") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["connectorVersion", "platform"], ["adapterCapabilities"]);
      return send(response, 200, { ok: true, result: { ...await options.store.heartbeat(principal, body as never),
        releaseTrust, ...(release ? { connector: release.advertisement } : {}) } });
    }
    if (path === "/fleet/v1/rotate") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["newCredentialDigest"]);
      const result = await options.store.rotate(principal, body as never);
      admission.registerCredential(principal.workerId, body.newCredentialDigest as string);
      return send(response, 200, { ok: true, result });
    }
    if (path === "/fleet/v1/claims") {
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["offerId", "idempotencyKey"]);
      const result = await options.store.claim(principal, body as never);
      return send(response, result.replayed ? 200 : 201, { ok: true, result });
    }
    const claim = claimRoute.exec(path);
    if (claim) {
      const [, claimId, action] = claim;
      if (action === "progress") {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["message", "idempotencyKey"]);
        return send(response, 200, { ok: true, result: await options.store.progress(principal, { ...body, claimId } as never) });
      }
      if (action === "blocker") {
        const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.small), ["message", "idempotencyKey"], ["release"]);
        return send(response, 200, { ok: true, result: await options.store.blocker(principal, { ...body, claimId } as never) });
      }
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.result), ["summary", "idempotencyKey"], ["files"]);
      const result = await options.store.submitResult(principal, { claimId, summary: body.summary,
        idempotencyKey: body.idempotencyKey, files: decodeFiles(body.files) });
      return send(response, result.replayed ? 200 : 201, { ok: true, result });
    }
    const proposal = proposalRoute.exec(path);
    if (proposal) {
      let projectId: string;
      try { projectId = decodeURIComponent(proposal[1]!); } catch { return fleetFail("not_found"); }
      if (!FLEET_PROJECT_ID_PATTERN_V1.test(projectId) || encodeURIComponent(projectId) !== proposal[1]
        || !principal.projectIds.includes(projectId)) return fleetFail("not_found");
      if (!options.proposals) return fleetFail("unavailable");
      const body = object(await readBody(request, FLEET_BODY_LIMITS_V1.proposal), ["idempotencyKey", "proposal"]);
      if (typeof body.idempotencyKey !== "string" || !body.proposal || typeof body.proposal !== "object"
        || Array.isArray(body.proposal)) return fleetFail("invalid");
      const at = now();
      // The same S1 proposal service as the website intake: a proposal starts
      // no work and grants no authority until the owner approves it.
      let result;
      try {
        result = await options.proposals.submit({ principal: { tenantId: principal.tenantId,
          identityId: principal.identityId, actorType: "agent", authenticatedAt: at,
          expiresAt: principal.credentialExpiresAt },
        projectId, rawProposal: JSON.stringify(body.proposal), idempotencyKey: body.idempotencyKey, now: at });
      } catch (error) {
        if (error instanceof WorkIntakeErrorV1 && WORK_INTAKE_REFUSALS_V1[error.safeCode])
          return fleetFail(WORK_INTAKE_REFUSALS_V1[error.safeCode]!);
        throw error;
      }
      return send(response, "accepted" in result && result.accepted === false ? 422 : 202, { ok: true, result });
    }
    return fleetFail("not_found");
  }

  return Object.freeze({
    async handle(request: IncomingMessage, response: ServerResponse) {
      try { await route(request, response); }
      catch (error) {
        if (response.headersSent) { response.destroy(); return; }
        if (databaseUnavailable(error)) {
          options.onUnexpectedError?.(error);
          send(response, 503, { ok: false, error: "unavailable" }, { "retry-after": "1" });
          return;
        }
        if (!(error instanceof FleetErrorV1)) options.onUnexpectedError?.(error);
        const code = error instanceof FleetErrorV1 ? error.code : "refused";
        const status = error instanceof FleetErrorV1 ? error.status : 400;
        send(response, status, { ok: false, error: code });
      }
    },
  });
}
