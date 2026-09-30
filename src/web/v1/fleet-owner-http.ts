import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust,
  type GatewayAssertionProviderProfileV1 } from "./access-verifier";
import type { LocalOwnerSessionServiceV1 } from "./local-owner-session";
import { privateResponseHeaders, readBoundedJson, webFailure } from "./http-common";
import { FleetErrorV1, FLEET_WORKER_KINDS_V1, type FleetOwnerServiceV1 } from "../../fleet/v1";
import { captureFleetConnectorReleaseManifestV1, type FleetConnectorReleaseManifestV1 } from "../../fleet/v1/connector-release";

/**
 * Owner-only fleet routes: add a worker, give it a new key, revoke it, open a
 * task to fleet workers, and review results. Worker machines never call these;
 * they use the separate connector gateway with their own credential.
 */
export type FleetOwnerHttpOptionsV1 = Readonly<{ origin: string; service: FleetOwnerServiceV1;
  /** Public address of the connector gateway, shown in the one-line join command. */
  gatewayOrigin?: string; connectorRelease?: FleetConnectorReleaseManifestV1;
  trust?: AccessTrust; gatewayAssertionProfile?: GatewayAssertionProviderProfileV1;
  clock?: () => number; localOwnerSession?: LocalOwnerSessionServiceV1 }>;

function translate(error: unknown): never {
  if (error instanceof FleetErrorV1) throw new WebAccessError(error.code === "not_found" ? "not_found"
    : error.code === "conflict" || error.code === "expired" ? "conflict" : "invalid_request");
  throw error;
}

const shellSafe = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/u;
const connectOperatingSystems = ["macos", "windows", "linux"] as const;
type ConnectOperatingSystem = typeof connectOperatingSystems[number];

/** This endpoint deliberately asks the service to validate the display name.
 * That keeps its Unicode/HTML-safe display policy identical to every other
 * owner enrollment route, while rejecting newlines and control characters. */
function captureConnectBotRequestV1(body: Record<string, unknown>) {
  if (Object.keys(body).sort().join(",") !== "botKind,capabilities,name,operatingSystem,projectIds"
    || typeof body.name !== "string" || typeof body.botKind !== "string"
    || !FLEET_WORKER_KINDS_V1.includes(body.botKind as never)
    || !(connectOperatingSystems as readonly string[]).includes(body.operatingSystem as string))
    throw new WebAccessError("invalid_request");
  return Object.freeze({ displayName: body.name, workerKind: body.botKind,
    operatingSystem: body.operatingSystem as ConnectOperatingSystem,
    projectIds: body.projectIds, capabilities: body.capabilities });
}
const installerCheck = `const f=require("fs"),c=require("crypto"),a=process.argv.slice(1);try{const b=f.readFileSync(a[0]),m=JSON.parse(f.readFileSync(a[1],"utf8")),k=Object.keys(m).sort().join(",");if(k!=="builtFrom,file,schema,sha256,size,version"||m.schema!=="control-room.fleet-connector-release/v1"||m.version!==a[2]||m.file!=="connector-"+a[2]+".mjs"||m.sha256!==a[3]||m.size!==Number(a[4])||m.builtFrom!==a[5]||b.length!==m.size||c.createHash("sha256").update(b).digest("hex")!==m.sha256)throw 0}catch{console.error("This download does not match what Control Room showed you. Nothing was installed.");process.exit(1)}`;
export const FLEET_CONNECTOR_INSTALLER_CHECK_BASE64_V1 = Buffer.from(installerCheck).toString("base64");

/** The exact commands shown to the owner. The code is the only secret in it
 * and it is short-lived and single use. */
export function fleetJoinCommandsV1(gatewayOrigin: string, code: string, workerKind: string, releaseValue: FleetConnectorReleaseManifestV1) {
  if (!shellSafe.test(gatewayOrigin) || !/^crj_[A-Za-z0-9_-]{43}$/u.test(code)
    || !(FLEET_WORKER_KINDS_V1 as readonly string[]).includes(workerKind)) throw new WebAccessError("invalid_request");
  let release: FleetConnectorReleaseManifestV1;
  try { release = captureFleetConnectorReleaseManifestV1(releaseValue); } catch { throw new WebAccessError("invalid_request"); }
  const url = `${gatewayOrigin}/fleet/v1/${release.file}`;
  const manifestUrl = `${gatewayOrigin}/fleet/v1/connector-manifest.json`;
  const check = `node -e "eval(Buffer.from('${FLEET_CONNECTOR_INSTALLER_CHECK_BASE64_V1}','base64').toString())"`;
  const expected = `${release.version} ${release.sha256} ${release.size} ${release.builtFrom}`;
  return Object.freeze({
    unix: `d="$HOME/.local/share/control-room"; mkdir -p "$d" && curl -fsSL ${url} -o "$d/${release.file}" && curl -fsSL ${manifestUrl} -o "$d/connector-manifest.json" && ${check} "$d/${release.file}" "$d/connector-manifest.json" ${expected} && node "$d/${release.file}" join --server ${gatewayOrigin} --code ${code} --bot ${workerKind}`,
    windows: `$d=Join-Path $env:LOCALAPPDATA 'ControlRoom'; New-Item -ItemType Directory -Force $d | Out-Null; $f=Join-Path $d '${release.file}'; $m=Join-Path $d 'connector-manifest.json'; Invoke-WebRequest ${url} -OutFile $f; Invoke-WebRequest ${manifestUrl} -OutFile $m; ${check} $f $m ${expected}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node $f join --server ${gatewayOrigin} --code ${code} --bot ${workerKind}`,
  });
}

export function createFleetOwnerHttpHandlerV1(options: FleetOwnerHttpOptionsV1) {
  const local = options.localOwnerSession;
  if (local && (options.trust || options.gatewayAssertionProfile) || !local && !options.trust)
    throw new Error("fleet_owner_http_authentication_invalid");
  if ((options.gatewayOrigin === undefined) !== (options.connectorRelease === undefined)
    || options.gatewayOrigin !== undefined && !shellSafe.test(options.gatewayOrigin)) throw new Error("fleet_owner_http_gateway_invalid");
  let connectorRelease: FleetConnectorReleaseManifestV1 | undefined;
  try { connectorRelease = options.connectorRelease && captureFleetConnectorReleaseManifestV1(options.connectorRelease); }
  catch { throw new Error("fleet_owner_http_gateway_invalid"); }
  const verify = options.trust ? createAccessVerifier(options.trust, options.gatewayAssertionProfile) : undefined;
  const clock = options.clock ?? Date.now;
  const withCommands = <T extends { code: string; workerKind: string }>(issued: T) => ({ ...issued,
    ...(options.gatewayOrigin && connectorRelease
      ? { commands: fleetJoinCommandsV1(options.gatewayOrigin, issued.code, issued.workerKind, connectorRelease) } : {}) });

  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, clock()) : verify!(request, clock());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      const path = url.pathname;
      const file = /^\/api\/v1\/fleet\/results\/(fleet-result:[a-f0-9]{32})\/files\/([1-8])$/u.exec(path);
      if (request.method === "GET") {
        if (path === "/api/v1/fleet") {
          const [board, results] = await Promise.all([options.service.listWorkers(identity),
            options.service.listResults(identity, { awaitingOnly: false })]).catch(translate);
          return Response.json({ ...board, results, gatewayConfigured: !!options.gatewayOrigin,
            connectBot: connectorRelease ? { available: true, release: connectorRelease } : { available: false } },
          { headers: privateResponseHeaders });
        }
        const files = /^\/api\/v1\/fleet\/results\/(fleet-result:[a-f0-9]{32})\/files$/u.exec(path);
        if (files) return Response.json(await options.service.listResultFiles(identity, files[1]).catch(translate),
          { headers: privateResponseHeaders });
        if (file) {
          const value = await options.service.readResultFile(identity, file[1], Number(file[2])).catch(translate);
          // Worker files are always downloads, never rendered in the app origin.
          return new Response(Buffer.from(value.content), { headers: { ...privateResponseHeaders,
            "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${value.fileName}"`,
            "content-security-policy": "default-src 'none'; sandbox" } });
        }
        throw new WebAccessError("not_found");
      }
      if (request.method !== "POST" || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
        || !request.body) throw new WebAccessError("invalid_request");
      const body = await readBoundedJson(request.body, 16_384) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new WebAccessError("invalid_request");
      if (path === "/api/v1/fleet/connect-codes") {
        if (!options.gatewayOrigin || !connectorRelease) throw new WebAccessError("not_found");
        const input = captureConnectBotRequestV1(body);
        const issued = await options.service.createEnrollmentCode(identity, input).catch(translate);
        const commands = fleetJoinCommandsV1(options.gatewayOrigin, issued.code, issued.workerKind, connectorRelease);
        return Response.json({ codeId: issued.codeId, workerId: issued.workerId, expiresAt: issued.expiresAt,
          operatingSystem: input.operatingSystem, release: connectorRelease,
          // The UI selects one of these exact strings; it must never recreate
          // a command, digest, download URL, or bot argument in the browser.
          installLine: input.operatingSystem === "windows" ? commands.windows : commands.unix },
        { status: 201, headers: privateResponseHeaders });
      }
      if (path === "/api/v1/fleet/enrollment-codes") return Response.json(withCommands(await options.service
        .createEnrollmentCode(identity, body as never).catch(translate)), { status: 201, headers: privateResponseHeaders });
      const worker = /^\/api\/v1\/fleet\/workers\/(fleet-worker:[a-f0-9]{32})\/(revoke|new-key)$/u.exec(path);
      if (worker) {
        if (worker[2] === "revoke") return Response.json(await options.service.revokeWorker(identity, worker[1]).catch(translate),
          { headers: privateResponseHeaders });
        return Response.json(withCommands(await options.service.issueRekeyCode(identity, worker[1]).catch(translate)),
          { status: 201, headers: privateResponseHeaders });
      }
      const code = /^\/api\/v1\/fleet\/enrollment-codes\/(fleet-code:[a-f0-9]{32})\/cancel$/u.exec(path);
      if (code) return Response.json(await options.service.cancelCode(identity, code[1]).catch(translate), { headers: privateResponseHeaders });
      const review = /^\/api\/v1\/fleet\/results\/(fleet-result:[a-f0-9]{32})\/review$/u.exec(path);
      if (review) return Response.json(await options.service.review(identity, { resultId: review[1], decision: body.decision,
        note: body.note }).catch(translate), { headers: privateResponseHeaders });
      if (path === "/api/v1/fleet/offers") return Response.json(await options.service.offerTask(identity, body as never).catch(translate),
        { status: 201, headers: privateResponseHeaders });
      const withdraw = /^\/api\/v1\/fleet\/offers\/(fleet-offer:[a-f0-9]{32})\/withdraw$/u.exec(path);
      if (withdraw) return Response.json(await options.service.withdrawOffer(identity, withdraw[1]).catch(translate),
        { headers: privateResponseHeaders });
      throw new WebAccessError("not_found");
    } catch (error) { return webFailure(error); }
  };
}
