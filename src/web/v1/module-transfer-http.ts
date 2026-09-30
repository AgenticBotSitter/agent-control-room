import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust, type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import type { WebProjectService } from "./project-service";
import type { ModuleBundleSubmissionV1, ModuleInstallApprovalServiceV1 } from "../../modules/v1/install-approvals";
import type { ModuleTransferServiceV1 } from "../../modules/v1/transfer-service";
import { isModuleSemverV1 } from "../../modules/v1/manifest";
import { exportProjectAsPackV1 } from "../../project-packs/transfer";

/**
 * Module and project-pack download/upload. Every route here is inert: a
 * download only serializes an already-verified server-side object, and an
 * upload only previews or records an owner approval through the existing
 * bundle verifier and approval ledger. Nothing here loads, executes, stages,
 * or migrates a module, and nothing here installs one.
 */

const MODULE_ID_PATTERN = /^[a-z][A-Za-z0-9.-]{2,63}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_-]{16,100}$/;
/**
 * A canonical bundle's own content ceiling is 8 MiB (`MAX_TOTAL_BYTES` in
 * `bundle.ts`). Base64 expands that by ~4/3, and the manifest (up to 128 KiB)
 * travels alongside as inline JSON, not inside that ceiling. 12 MB leaves
 * comfortable JSON-structural slack above the largest bundle the verifier
 * could ever accept, while still refusing an unbounded upload outright.
 */
const MAX_BUNDLE_SUBMISSION_BYTES = 12_000_000;
const UPLOAD_TIMEOUT_MS = 20_000;

function jsonFileResponse(fileName: string, digestHeader: string, digest: string, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { ...privateResponseHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${fileName}"`,
    [digestHeader]: digest } });
}

async function readSubmissionBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !request.body)
    throw new WebAccessError("invalid_request");
  return readBoundedJson(request.body, MAX_BUNDLE_SUBMISSION_BYTES, UPLOAD_TIMEOUT_MS);
}

export function createModuleTransferHttpHandlerV1(options: {
  origin: string; trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1; clock?: () => number;
  localOwnerSession?: LocalOwnerSessionServiceV1;
  transfers: ModuleTransferServiceV1; approvals: ModuleInstallApprovalServiceV1; projects: WebProjectService;
}) {
  const localOwnerSession = options.localOwnerSession;
  if (localOwnerSession && (options.trust !== undefined || options.gatewayAssertionProfile !== undefined))
    throw new Error("module_transfer_http_authentication_modes_conflict");
  const verifyIdentity = localOwnerSession ? undefined : options.trust === undefined ? undefined
    : createAccessVerifier(options.trust, options.gatewayAssertionProfile);
  if (!localOwnerSession && !verifyIdentity) throw new Error("module_transfer_http_authentication_not_configured");
  const clock = options.clock ?? Date.now;
  return async (request: Request): Promise<Response> => {
    try {
      if (localOwnerSession) localOwnerSession.assertLocalRequest(request, !["GET", "HEAD"].includes(request.method));
      else requireSameOrigin(request, options.origin);
      const identity = localOwnerSession ? localOwnerSession.verify(request, clock()) : verifyIdentity!(request, clock());
      const url = new URL(request.url), path = url.pathname;

      const bundle = /^\/api\/v1\/modules\/([^/]+)\/bundle$/.exec(path);
      if (bundle) {
        if (request.method !== "GET") throw new WebAccessError("invalid_request");
        let moduleId: string;
        try { moduleId = decodeURIComponent(bundle[1]); } catch { throw new WebAccessError("invalid_request"); }
        if (!MODULE_ID_PATTERN.test(moduleId) || [...url.searchParams.keys()].some(key => key !== "version")
          || url.searchParams.getAll("version").length > 1) throw new WebAccessError("invalid_request");
        const version = url.searchParams.get("version") ?? undefined;
        if (version !== undefined && !isModuleSemverV1(version)) throw new WebAccessError("invalid_request");
        const download = await options.transfers.downloadModule(identity, moduleId, version);
        return jsonFileResponse(download.fileName, "x-control-room-bundle-digest", download.bundleDigest,
          { bundle: download.bundle, signature: download.signature });
      }

      if (path === "/api/v1/modules/preview" && request.method === "POST") {
        const submission = await readSubmissionBody(request) as ModuleBundleSubmissionV1;
        return Response.json(await options.approvals.preview(identity, submission), { headers: privateResponseHeaders });
      }

      if (path === "/api/v1/modules/approvals" && request.method === "POST") {
        const value = await readSubmissionBody(request);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WebAccessError("invalid_request");
        const { submission, draft } = value as { submission?: unknown; draft?: unknown };
        if (submission === undefined || draft === undefined || Object.keys(value as object).length !== 2)
          throw new WebAccessError("invalid_request");
        const idempotencyKey = request.headers.get("idempotency-key") ?? "";
        if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw new WebAccessError("invalid_request");
        const result = await options.approvals.approve(identity, submission as ModuleBundleSubmissionV1, draft, idempotencyKey);
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: privateResponseHeaders });
      }

      const pack = /^\/api\/v1\/projects\/([^/]+)\/pack$/.exec(path);
      if (pack) {
        if (request.method !== "GET" || url.search) throw new WebAccessError("invalid_request");
        let projectId: string;
        try { projectId = decodeURIComponent(pack[1]); } catch { throw new WebAccessError("invalid_request"); }
        const project = await options.projects.getView(identity, projectId);
        const download = exportProjectAsPackV1({ title: project.title, summary: project.summary,
          enabledModules: project.presentation?.enabledModules ?? [] });
        return jsonFileResponse(download.fileName, "x-control-room-pack-digest", download.digest, download.pack);
      }

      return Response.json({ error: "not_found" }, { status: 404, headers: privateResponseHeaders });
    } catch (error) { return webFailure(error); }
  };
}
