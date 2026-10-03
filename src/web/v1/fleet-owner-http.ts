import { privateRequestBudgets } from "./private-request-budgets";
import { ownerWorkerNoteV1 } from "../../fleet/v1/owner-note";
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
  /** Public address of the connector gateway, shown in the one-line install command. */
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
const unattendedWorkerKinds = ["claude-code", "codex", "hermes"] as const;
const workerSelectionPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
type ConnectOperatingSystem = typeof connectOperatingSystems[number];

/** This endpoint deliberately asks the service to validate the display name.
 * That keeps its Unicode/HTML-safe display policy identical to every other
 * owner enrollment route, while rejecting newlines and control characters. */
function captureConnectBotRequestV1(body: Record<string, unknown>) {
  if (Object.keys(body).sort().join(",") !== "botKind,capabilities,name,operatingSystem,projectIds,unattended,workerModel,workerProfile,workerProvider"
    || typeof body.name !== "string" || typeof body.botKind !== "string"
    || typeof body.unattended !== "boolean"
    || typeof body.workerModel !== "string" || typeof body.workerProfile !== "string" || typeof body.workerProvider !== "string"
    || !FLEET_WORKER_KINDS_V1.includes(body.botKind as never)
    || body.unattended && !(unattendedWorkerKinds as readonly string[]).includes(body.botKind)
    || body.botKind === "hermes" && body.unattended && ![body.workerProfile, body.workerModel, body.workerProvider]
      .every(value => workerSelectionPattern.test(value as string))
    || (body.botKind !== "hermes" || !body.unattended) && [body.workerProfile, body.workerModel, body.workerProvider]
      .some(value => value !== "")
    || !(connectOperatingSystems as readonly string[]).includes(body.operatingSystem as string))
    throw new WebAccessError("invalid_request");
  return Object.freeze({ displayName: body.name, workerKind: body.botKind,
    operatingSystem: body.operatingSystem as ConnectOperatingSystem,
    projectIds: body.projectIds, capabilities: body.capabilities, unattended: body.unattended,
    workerModel: body.workerModel, workerProfile: body.workerProfile, workerProvider: body.workerProvider });
}
const installerCheck = `const f=require("fs"),c=require("crypto"),a=process.argv.slice(1);try{const b=f.readFileSync(a[0]),m=JSON.parse(f.readFileSync(a[1],"utf8")),k=Object.keys(m).sort().join(",");if(k!=="builtFrom,file,schema,sha256,size,version"||m.schema!=="control-room.fleet-connector-release/v1"||m.version!==a[2]||m.file!=="connector-"+a[2]+".mjs"||m.sha256!==a[3]||m.size!==Number(a[4])||m.builtFrom!==a[5]||b.length!==m.size||c.createHash("sha256").update(b).digest("hex")!==m.sha256)throw 0}catch{console.error("This download does not match what Control Room showed you. Nothing was installed.");process.exit(1)}`;
export const FLEET_CONNECTOR_INSTALLER_CHECK_BASE64_V1 = Buffer.from(installerCheck).toString("base64");

const workerIdPattern = /^fleet-worker:[a-f0-9]{32}$/u;
const displayNamePattern = /^[^\u0000-\u001F\u007F]{1,80}$/u;

/** The profile is shell-safe, recognizable, stable across rekeys, and unique
 * even when two owners choose the same display name. The raw display name is
 * never interpolated into a command. */
export function fleetConnectorProfileNameV1(displayNameValue: string, workerId: string, workerKind: string) {
  if (typeof displayNameValue !== "string") throw new WebAccessError("invalid_request");
  const displayName = displayNameValue.trim();
  if (!displayNamePattern.test(displayName) || !workerIdPattern.test(workerId)
    || !(FLEET_WORKER_KINDS_V1 as readonly string[]).includes(workerKind)) throw new WebAccessError("invalid_request");
  const stem = displayName.normalize("NFKD").replace(/[^\x00-\x7F]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || workerKind;
  return `${stem.slice(0, 47).replace(/-+$/u, "") || workerKind}-${workerId.slice(-12)}`;
}

export function fleetConnectorOwnerNextStepV1(workerKind: string, operatingSystem: ConnectOperatingSystem,
  profileName: string, unattended = false, releaseFile = "connector.mjs") {
  if (!(FLEET_WORKER_KINDS_V1 as readonly string[]).includes(workerKind)
    || !(connectOperatingSystems as readonly string[]).includes(operatingSystem)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profileName)
    || !/^(?:connector-(?:\d+\.){2}\d+\.mjs|connector\.mjs)$/u.test(releaseFile)) throw new WebAccessError("invalid_request");
  if (unattended && !(unattendedWorkerKinds as readonly string[]).includes(workerKind))
    throw new WebAccessError("invalid_request");
  const label = workerKind === "claude-code" ? "Claude Code" : workerKind === "codex" ? "Codex"
    : workerKind === "hermes" ? "Hermes" : workerKind === "cursor" ? "Cursor"
      : workerKind === "claude-desktop" ? "Claude Desktop" : "your generic MCP host";
  if (unattended) {
    const connector = operatingSystem === "windows" ? `(Join-Path $env:LOCALAPPDATA 'ControlRoom\\${releaseFile}')`
      : `"$HOME/.local/share/control-room/${releaseFile}"`;
    const uninstall = `node ${connector} uninstall --bot ${workerKind} --name ${profileName} --i-am-the-installer`;
    return `The per-user background worker is installed and checks for approved work after you sign in. It only starts the ${label} harness when that harness is enabled in harnesses.json. To turn it off and remove this profile, run: ${uninstall}`;
  }
  if (workerKind === "cursor" || workerKind === "claude-desktop")
    return `${label} is registered. Close and reopen ${label}; it starts the connector when needed, so no background service is required.`;
  if (workerKind === "mcp-agent") {
    const path = operatingSystem === "windows" ? "%APPDATA%\\control-room\\generic-mcp.json"
      : "$XDG_CONFIG_HOME/control-room/generic-mcp.json (or ~/.config/control-room/generic-mcp.json when XDG_CONFIG_HOME is unset)";
    return `Import the control-room-${profileName} entry from ${path} into your generic MCP host. The host starts the connector when needed; no background service is required.`;
  }
  return `${label} is registered now. Open ${label} and ask it to list Control Room work; it starts the connector when needed, so no background service or restart is required.`;
}

/** The exact commands shown to the owner. The code is the only secret in it
 * and it is short-lived and single use. Each command verifies the release,
 * creates a private workspace, joins, and registers one MCP profile. */
export function fleetJoinCommandsV1(gatewayOrigin: string, code: string, workerKind: string,
  releaseValue: FleetConnectorReleaseManifestV1, identity: Readonly<{ displayName: string; workerId: string }>,
  unattended = false, workerSelection: Readonly<{ model?: string; profile?: string; provider?: string }> = {}) {
  if (!shellSafe.test(gatewayOrigin) || !/^crj_[A-Za-z0-9_-]{43}$/u.test(code)
    || !(FLEET_WORKER_KINDS_V1 as readonly string[]).includes(workerKind)
    || unattended && !(unattendedWorkerKinds as readonly string[]).includes(workerKind)
    || workerKind === "hermes" && unattended && ![workerSelection.profile, workerSelection.model, workerSelection.provider]
      .every(value => typeof value === "string" && workerSelectionPattern.test(value))
    || (workerKind !== "hermes" || !unattended) && Object.values(workerSelection).some(value => value !== undefined))
    throw new WebAccessError("invalid_request");
  let release: FleetConnectorReleaseManifestV1;
  try { release = captureFleetConnectorReleaseManifestV1(releaseValue); } catch { throw new WebAccessError("invalid_request"); }
  const profileName = fleetConnectorProfileNameV1(identity.displayName, identity.workerId, workerKind);
  const url = `${gatewayOrigin}/fleet/v1/${release.file}`;
  const manifestUrl = `${gatewayOrigin}/fleet/v1/connector-manifest.json`;
  const check = `node -e "eval(Buffer.from('${FLEET_CONNECTOR_INSTALLER_CHECK_BASE64_V1}','base64').toString())"`;
  const expected = `${release.version} ${release.sha256} ${release.size} ${release.builtFrom}`;
  const workerArguments = unattended && workerKind === "hermes"
    ? ` --worker-profile ${workerSelection.profile} --worker-model ${workerSelection.model} --worker-provider ${workerSelection.provider}` : "";
  const unattendedArgument = unattended ? `${workerArguments} --unattended` : "";
  return Object.freeze({
    profileName,
    unix: `d="$HOME/.local/share/control-room"; w="$HOME/ControlRoomWork/${profileName}"; mkdir -p "$d" && curl -fsSL ${url} -o "$d/${release.file}" && curl -fsSL ${manifestUrl} -o "$d/connector-manifest.json" && ${check} "$d/${release.file}" "$d/connector-manifest.json" ${expected} && node "$d/${release.file}" install --server ${gatewayOrigin} --code ${code} --bot ${workerKind} --name ${profileName} --workspace "$w"${unattendedArgument} --i-am-the-installer`,
    windows: `$d=Join-Path $env:LOCALAPPDATA 'ControlRoom'; $w=Join-Path $HOME 'ControlRoomWork\\${profileName}'; New-Item -ItemType Directory -Force $d | Out-Null; $f=Join-Path $d '${release.file}'; $m=Join-Path $d 'connector-manifest.json'; Invoke-WebRequest ${url} -OutFile $f; Invoke-WebRequest ${manifestUrl} -OutFile $m; ${check} $f $m ${expected}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node $f install --server ${gatewayOrigin} --code ${code} --bot ${workerKind} --name ${profileName} --workspace $w${unattendedArgument} --i-am-the-installer`,
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
  const withCommands = <T extends { code: string; workerKind: string; displayName: string; workerId: string }>(issued: T) => ({ ...issued,
    ...(options.gatewayOrigin && connectorRelease
      ? { commands: fleetJoinCommandsV1(options.gatewayOrigin, issued.code, issued.workerKind, connectorRelease,
        { displayName: issued.displayName, workerId: issued.workerId }) } : {}) });

  return async (request: Request): Promise<Response> => {
    try {
      if (local) local.assertLocalRequest(request, request.method !== "GET"); else requireSameOrigin(request, options.origin);
      const identity = local ? local.verify(request, clock()) : verify!(request, clock());
      const url = new URL(request.url);
      if (url.search) throw new WebAccessError("invalid_request");
      // The Workers page builds every id segment with encodeURIComponent, so a
      // browser asks for `fleet-result%3A…` while the routes below name ids with
      // a literal colon. Matching the raw pathname 404'd every owner action on
      // a worker, code or result (accept, ask for changes, reject, files, new
      // key, remove, cancel). Match on the decoded segments instead; an encoded
      // "/" never becomes a separator.
      let path: string;
      try {
        path = url.pathname.split("/").map(segment => {
          const decoded = decodeURIComponent(segment);
          if (decoded.includes("/")) throw new Error("encoded_separator");
          return decoded;
        }).join("/");
      } catch { throw new WebAccessError("invalid_request"); }
      const file = /^\/api\/v1\/fleet\/results\/(fleet-result:[a-f0-9]{32})\/files\/([1-8])$/u.exec(path);
      if (request.method === "GET") {
        if (path === "/api/v1/fleet") {
          const [board, results] = await Promise.all([options.service.listWorkers(identity),
            options.service.listResults(identity, { awaitingOnly: false })]).catch(translate);
          return Response.json({ ...board, workers: board.workers.map(worker => ({ ...worker, latestNote: worker.latestNote
            ? ownerWorkerNoteV1(worker.latestNote) : null })), results, gatewayConfigured: !!options.gatewayOrigin,
            connectBot: connectorRelease ? { available: true, release: connectorRelease } : { available: false } },
          { headers: privateResponseHeaders });
        }
        const offers = /^\/api\/v1\/fleet\/projects\/([^/]+)\/offers$/u.exec(path);
        if (offers) return Response.json(await options.service.projectOffers(identity, decodeURIComponent(offers[1])).catch(translate),
          { headers: privateResponseHeaders });
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
      const body = await readBoundedJson(request.body, privateRequestBudgets.fleet) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new WebAccessError("invalid_request");
      if (path === "/api/v1/fleet/connect-codes") {
        if (!options.gatewayOrigin || !connectorRelease) throw new WebAccessError("not_found");
        const input = captureConnectBotRequestV1(body);
        const issued = await options.service.createEnrollmentCode(identity, { displayName: input.displayName,
          workerKind: input.workerKind, projectIds: input.projectIds, capabilities: input.capabilities }).catch(translate);
        const commands = fleetJoinCommandsV1(options.gatewayOrigin, issued.code, issued.workerKind, connectorRelease,
          { displayName: input.displayName, workerId: issued.workerId }, input.unattended,
          input.unattended && input.workerKind === "hermes" ? { model: input.workerModel,
            profile: input.workerProfile, provider: input.workerProvider } : {});
        return Response.json({ codeId: issued.codeId, workerId: issued.workerId, expiresAt: issued.expiresAt,
          operatingSystem: input.operatingSystem, botKind: issued.workerKind, profileName: commands.profileName,
          unattended: input.unattended,
          ownerNextStep: fleetConnectorOwnerNextStepV1(issued.workerKind, input.operatingSystem, commands.profileName,
            input.unattended, connectorRelease.file),
          release: connectorRelease,
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
      if (path === "/api/v1/fleet/offers") {
        if (body.allowedWorkerIds !== undefined && body.allowedWorkerIds !== null) {
          const ids = body.allowedWorkerIds;
          if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20
            || !ids.every(id => typeof id === "string" && workerIdPattern.test(id))
            || new Set(ids).size !== ids.length) throw new WebAccessError("invalid_request");
          const board = await options.service.listWorkers(identity).catch(translate);
          if (!ids.every(id => board.workers.some(worker => worker.workerId === id
            && worker.status !== "revoked" && worker.projectIds.includes(body.projectId as string))))
            throw new WebAccessError("invalid_request");
        }
        const offered = await options.service.offerTask(identity, body as never).catch(translate);
        // Replays do not update the saved allow-list. Never imply this draft changed it.
        if (offered.replayed) throw new WebAccessError("conflict");
        return Response.json(offered, { status: 201, headers: privateResponseHeaders });
      }
      const withdraw = /^\/api\/v1\/fleet\/offers\/(fleet-offer:[a-f0-9]{32})\/withdraw$/u.exec(path);
      if (withdraw) return Response.json(await options.service.withdrawOffer(identity, withdraw[1]).catch(translate),
        { headers: privateResponseHeaders });
      throw new WebAccessError("not_found");
    } catch (error) { return webFailure(error); }
  };
}
