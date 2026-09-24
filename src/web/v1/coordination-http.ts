// HTTP handler for the project-coordination surface.
//
// Mounts the owner-authorised coordinator and delegation-policy lifecycle
// routes inside the private web process. Every route runs through the same
// `requireSameOrigin` + Cloudflare-Access JWT verifier as the rest of the
// private app, then funnels into ProjectCoordinationHttpService which itself
// runs every mutation through WebSessionAuthority.authenticated — so the
// human-only / owner-grant checks happen for real.
//
// Route table:
//
//   GET    /api/v1/projects/:projectId/coordination                    (read-only page)
//   POST   /api/v1/projects/:projectId/coordination/appoint-coordinator
//   POST   /api/v1/projects/:projectId/coordination/replace-coordinator
//   POST   /api/v1/projects/:projectId/coordination/revoke-coordinator
//   POST   /api/v1/projects/:projectId/coordination/pause-policy      (suspended: 403 until #220)
//   POST   /api/v1/projects/:projectId/coordination/resume-policy     (suspended: 403 until #220)
//   POST   /api/v1/projects/:projectId/coordination/revoke-policy     (suspended: 403 until #220)
//
// All POST routes require:
//   * Content-Type: application/json
//   * Idempotency-Key matching /^[A-Za-z0-9:_-]{8,160}$/
//   * JSON body under 2048 bytes
//   * A valid coordinator revision matching the current head (refused otherwise)

import { projectCoordinationActionResultSchema, projectCoordinationPageSchema } from "./project-coordination-wire";
import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust, type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders as responseHeaders, readBoundedJson, webFailure } from "./http-common";
import { sha256Digest } from "../../security/digest";
import type { ProjectCoordinationHttpService } from "./project-coordination-http";

type Identity = Parameters<ProjectCoordinationHttpService["read"]>[0];
type RevisionInput = Parameters<ProjectCoordinationHttpService["appointCoordinator"]>[1] extends infer T
  ? T extends { revision: infer R } ? R : never : never;

export interface CoordinationHttpHandlerOptions {
  origin: string;
  trust?: AccessTrust;
  service: ProjectCoordinationHttpService;
  /** Trusted process selection; the browser cannot choose a header/provider. */
  gatewayAssertionProfile?: GatewayAssertionProviderProfileV1;
  clock?: () => number;
  /** Explicit loopback-only owner-session service; never a generic injected verifier. */
  localOwnerSession?: LocalOwnerSessionServiceV1;
  /**
   * Async predicate returning whether the coordination surface accepts writes.
   * When false, every POST route refuses with `not_found` and the read still succeeds.
   * The page read in the same handler is the natural place to consult this flag.
   */
  isCoordinationEnabled?: () => Promise<boolean>;
  /**
   * In-flight request coalescing, shared across handler invocations within one
   * process. Two simultaneous POSTs carrying the same Idempotency-Key run the
   * engine once; both callers receive the same recorded outcome. This is a
   * performance optimization only — durability comes from the coordinator
   * service's PostgreSQL receipt (control_idempotency): sequential retries
   * and reconstructed handlers are answered from the saved receipt.
   */
  inflight?: Map<string, Promise<unknown>>;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{8,160}$/;
const MAX_BODY_BYTES = 2048;

function readJsonBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !request.body) {
    throw new WebAccessError("invalid_request");
  }
  return readBoundedJson(request.body, MAX_BODY_BYTES);
}

function readIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value || !IDEMPOTENCY_KEY_RE.test(value)) throw new WebAccessError("invalid_request");
  return value;
}

function decodeProjectId(raw: string): string {
  try { return decodeURIComponent(raw); } catch { throw new WebAccessError("invalid_request"); }
}

function buildRevision(body: unknown): RevisionInput {
  if (!body || typeof body !== "object" || !("revision" in body)) {
    throw new WebAccessError("invalid_request");
  }
  return (body as { revision: RevisionInput }).revision;
}

function ensureEnabledOrRefuse(enabled: () => Promise<boolean>): Promise<void> {
  return enabled().then((ok) => {
    if (!ok) throw new WebAccessError("not_found");
  });
}

function extractPolicyFields(body: unknown): {
  revision: RevisionInput;
  policyId: string;
} {
  if (!body || typeof body !== "object") throw new WebAccessError("invalid_request");
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.policyId !== "string" || !candidate.policyId) {
    throw new WebAccessError("invalid_request");
  }
  return { revision: buildRevision(body), policyId: candidate.policyId };
}

function extractAppointFields(body: unknown): {
  revision: RevisionInput;
  coordinatorActorType: "human" | "agent";
  coordinatorIdentityId: string;
  executorId?: string;
  adapterId?: string;
  connectorProfileDigest?: string;
} {
  if (!body || typeof body !== "object") throw new WebAccessError("invalid_request");
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.coordinatorActorType !== "string") throw new WebAccessError("invalid_request");
  if (candidate.coordinatorActorType !== "human" && candidate.coordinatorActorType !== "agent") {
    throw new WebAccessError("invalid_request");
  }
  if (typeof candidate.coordinatorIdentityId !== "string" || !candidate.coordinatorIdentityId) {
    throw new WebAccessError("invalid_request");
  }
  return {
    revision: buildRevision(body),
    coordinatorActorType: candidate.coordinatorActorType,
    coordinatorIdentityId: candidate.coordinatorIdentityId,
    ...(typeof candidate.executorId === "string" ? { executorId: candidate.executorId } : {}),
    ...(typeof candidate.adapterId === "string" ? { adapterId: candidate.adapterId } : {}),
    ...(typeof candidate.connectorProfileDigest === "string"
      ? { connectorProfileDigest: candidate.connectorProfileDigest }
      : {}),
  };
}

export function createCoordinationHttpHandler(options: CoordinationHttpHandlerOptions) {
  const localOwnerSession = options.localOwnerSession;
  if (localOwnerSession && (localOwnerSession.profile.origin !== options.origin || new URL(options.origin).protocol !== "http:"))
    throw new Error("coordination_http_local_owner_config_invalid");
  if (localOwnerSession && (options.trust !== undefined || options.gatewayAssertionProfile !== undefined))
    throw new Error("coordination_http_authentication_modes_conflict");
  const verifyIdentity = localOwnerSession ? undefined : options.trust === undefined ? undefined
    : createAccessVerifier(options.trust, options.gatewayAssertionProfile);
  if (!localOwnerSession && !verifyIdentity) throw new Error("coordination_http_authentication_not_configured");
  const clock = options.clock ?? Date.now;
  const isCoordinationEnabled = options.isCoordinationEnabled ?? (() => Promise.resolve(true));
  const inflight = options.inflight ?? new Map<string, Promise<unknown>>();
  // Composite in-flight key. Identity subject is included so one owner's retry
  // can never be answered with another owner's outcome. The canonical body
  // digest is included so two simultaneous requests with the same key but
  // different content never share one outcome: each runs, and the PG
  // idempotency ledger (the durable authority) refuses the changed content
  // under the same key with coordinator_replay_conflict.
  const inflightKey = (idempotencyKey: string, projectId: string, subaction: string, identitySubject: string, bodyDigest: string) =>
    `${idempotencyKey}\n${projectId}\n${subaction}\n${identitySubject}\n${bodyDigest}`;
  return async (request: Request): Promise<Response> => {
    try {
        if (localOwnerSession) localOwnerSession.assertLocalRequest(request, !["GET", "HEAD"].includes(request.method));
        else requireSameOrigin(request, options.origin);
        const identity: Identity = localOwnerSession ? localOwnerSession.verify(request, clock()) : verifyIdentity!(request, clock());
        const url = new URL(request.url);
        const path = url.pathname;
        const coordination = /^\/api\/v1\/projects\/([^/]+)\/coordination(?:\/([^/]+))?$/.exec(path);
        if (!coordination) throw new WebAccessError("not_found");
        const projectId = decodeProjectId(coordination[1]);
        const subaction = coordination[2];
        const isRead = subaction === undefined;
        const isWrite = typeof subaction === "string";
        if (!isRead && !isWrite) throw new WebAccessError("not_found");

        if (isRead) {
          if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
          const page = await options.service.read(identity, projectId);
          return Response.json(projectCoordinationPageSchema.parse(page), { headers: responseHeaders });
        }

        if (request.method !== "POST" || url.search) throw new WebAccessError("invalid_request");
        const idempotencyKey = readIdempotencyKey(request);
        const body = await readJsonBody(request);
        await ensureEnabledOrRefuse(isCoordinationEnabled);

        const key = inflightKey(idempotencyKey, projectId, subaction, identity.subject, sha256Digest(body));
        // Atomic check-and-register: no await sits between get and set, so two
        // simultaneous same-key requests cannot both miss.
        const running = inflight.get(key);
        if (running) {
          const outcome = await running;
          return Response.json(outcome as object, { headers: responseHeaders });
        }
        const invocation = (async (): Promise<unknown> => {
          let outcome: unknown;
          // The route's exact Idempotency-Key flows into the coordinator
          // service, whose PG transaction is the durable replay authority.
          const lifecycle = <T extends Record<string, unknown>>(extra: T) => ({ projectId, ...extra, idempotencyKey });
          switch (subaction) {
            case "appoint-coordinator": {
              const input = lifecycle(extractAppointFields(body));
              outcome = await options.service.appointCoordinator(identity, input);
              break;
            }
            case "replace-coordinator": {
              const input = lifecycle(extractAppointFields(body));
              outcome = await options.service.replaceCoordinator(identity, input);
              break;
            }
            case "revoke-coordinator": {
              // Revoke uses the same shape as replace/appoint but with `operation: "revoke"`;
              // the HTTP service's revoke input is structurally identical to appoint input.
              const input = lifecycle(extractAppointFields(body));
              outcome = await options.service.revokeCoordinator(identity, input);
              break;
            }
            case "pause-policy": {
              const input = lifecycle(extractPolicyFields(body));
              outcome = await options.service.pauseDelegationPolicy(identity, input);
              break;
            }
            case "resume-policy": {
              const input = lifecycle(extractPolicyFields(body));
              outcome = await options.service.resumeDelegationPolicy(identity, input);
              break;
            }
            case "revoke-policy": {
              const input = lifecycle(extractPolicyFields(body));
              outcome = await options.service.revokeDelegationPolicy(identity, input);
              break;
            }
            default:
              throw new WebAccessError("not_found");
          }
          return projectCoordinationActionResultSchema.parse(outcome);
        })();
        inflight.set(key, invocation);
        try {
          const parsed = await invocation;
          return Response.json(parsed as object, { headers: responseHeaders });
        } finally {
          inflight.delete(key);
        }
    } catch (error) {
return webFailure(error);
    }
  };
}
