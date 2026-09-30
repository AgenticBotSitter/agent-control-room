import { WebAccessError } from "./access-verifier";

export const CONNECT_BOT_KINDS_V1 = Object.freeze([
  "claude-code", "codex", "hermes", "claude-desktop", "cursor",
] as const);
export const CONNECT_BOT_OPERATING_SYSTEMS_V1 = Object.freeze(["macos", "windows", "linux"] as const);

export type ConnectBotKindV1 = typeof CONNECT_BOT_KINDS_V1[number];
export type ConnectBotOperatingSystemV1 = typeof CONNECT_BOT_OPERATING_SYSTEMS_V1[number];
export type ConnectorManifestV1 = Readonly<{ path: string; sha256: string }>;

const codePattern = /^crj_[A-Za-z0-9_-]{43}$/u;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const connectorPathPattern = /^\/fleet\/v1\/connector(?:-[0-9]+\.[0-9]+\.[0-9]+)?\.mjs$/u;

function invalid(): never { throw new WebAccessError("invalid_request"); }

function gatewayOrigin(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return invalid(); }
  const tailnet = /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$/u.test(parsed.hostname);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (!(["https:", "http:"] as const).includes(parsed.protocol as "https:" | "http:") || parsed.username
    || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || parsed.origin !== value
    || parsed.protocol === "http:" && !tailnet && !loopback)
    return invalid();
  return parsed.origin;
}

function unixQuote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }
function powershellQuote(value: string) { return `'${value.replaceAll("'", "''")}'`; }

const verifyScript = "const f=require('node:fs'),c=require('node:crypto'),p=process.argv[1],e=process.argv[2],a='sha256:'+c.createHash('sha256').update(f.readFileSync(p)).digest('hex');if(a!==e){console.error('This download does not match what Control Room showed you. Nothing was installed.');process.exit(1)}";

/** One pasteable line for the selected terminal. The enrollment code is only
 * an install argument; it is never part of the download URL. The digest comes
 * from the signed-in owner's manifest port and is checked before execution. */
export function connectBotInstallLineV1(input: Readonly<{ gatewayOrigin: string; manifest: ConnectorManifestV1;
  code: string; botKind: ConnectBotKindV1; name: string; operatingSystem: ConnectBotOperatingSystemV1 }>) {
  const origin = gatewayOrigin(input.gatewayOrigin);
  if (!connectorPathPattern.test(input.manifest.path) || !digestPattern.test(input.manifest.sha256)
    || !codePattern.test(input.code) || !namePattern.test(input.name)
    || !(CONNECT_BOT_KINDS_V1 as readonly string[]).includes(input.botKind)
    || !(CONNECT_BOT_OPERATING_SYSTEMS_V1 as readonly string[]).includes(input.operatingSystem)) invalid();
  const url = `${origin}${input.manifest.path}`;
  const args = `install --server ${unixQuote(origin)} --code ${unixQuote(input.code)} --bot ${unixQuote(input.botKind)} --name ${unixQuote(input.name)} --i-am-the-installer`;
  if (input.operatingSystem !== "windows") {
    return `d="$HOME/.local/share/control-room/mcp" && mkdir -p "$d" && curl --fail --silent --show-error --location ${unixQuote(url)} -o "$d/connector.mjs" && node -e ${unixQuote(verifyScript)} "$d/connector.mjs" ${unixQuote(input.manifest.sha256)} && node "$d/connector.mjs" ${args}`;
  }
  const psArgs = `install --server ${powershellQuote(origin)} --code ${powershellQuote(input.code)} --bot ${powershellQuote(input.botKind)} --name ${powershellQuote(input.name)} --i-am-the-installer`;
  return `$ErrorActionPreference='Stop'; $d=Join-Path $env:LOCALAPPDATA 'ControlRoom\\mcp'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $p=Join-Path $d 'connector.mjs'; Invoke-WebRequest -UseBasicParsing -Uri ${powershellQuote(url)} -OutFile $p; & node -e ${powershellQuote(verifyScript)} $p ${powershellQuote(input.manifest.sha256)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & node $p ${psArgs}`;
}

export function captureConnectBotRequestV1(value: unknown): Readonly<{ botKind: ConnectBotKindV1; name: string;
  operatingSystem: ConnectBotOperatingSystemV1; projectIds: string[]; capabilities: string[]; maxConcurrent: 1 }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "botKind,capabilities,name,operatingSystem,projectIds"
    || typeof input.botKind !== "string" || !(CONNECT_BOT_KINDS_V1 as readonly string[]).includes(input.botKind)
    || typeof input.operatingSystem !== "string"
    || !(CONNECT_BOT_OPERATING_SYSTEMS_V1 as readonly string[]).includes(input.operatingSystem)
    || typeof input.name !== "string" || !namePattern.test(input.name)
    || !Array.isArray(input.projectIds) || !Array.isArray(input.capabilities)) invalid();
  return Object.freeze({ botKind: input.botKind as ConnectBotKindV1, name: input.name,
    operatingSystem: input.operatingSystem as ConnectBotOperatingSystemV1,
    projectIds: [...input.projectIds] as string[], capabilities: [...input.capabilities] as string[], maxConcurrent: 1 });
}

export function captureConnectorManifestV1(value: ConnectorManifestV1): ConnectorManifestV1 {
  if (!value || !connectorPathPattern.test(value.path) || !digestPattern.test(value.sha256))
    throw new Error("fleet_owner_http_connector_manifest_invalid");
  return Object.freeze({ path: value.path, sha256: value.sha256 });
}

export function captureConnectorGatewayOriginV1(value: string): string {
  try { return gatewayOrigin(value); }
  catch { throw new Error("fleet_owner_http_connector_gateway_invalid"); }
}
