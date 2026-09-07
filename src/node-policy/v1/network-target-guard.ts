import { isIP } from "node:net";
import { canonicalNetworkDestinationSchema } from "./schemas";
import { TargetGuardError } from "./target-guard-errors";

export interface CanonicalHttpsDestinationV1 {
  canonicalDestination: string;
  host: string;
  port: number;
  hostKind: "dns" | "ipv4";
}

export interface NetworkResolverV1 {
  resolve(host: string): Promise<string[]>;
}

export interface NetworkExecutorEnforcementV1 {
  exposesFinalDestination: boolean;
  supportsPinnedTlsConnection: boolean;
}

export interface PinnedHttpsConnectionPlanV1 extends CanonicalHttpsDestinationV1 {
  pinnedAddresses: string[];
  literalAddressException: boolean;
  resolvedAt: string;
}

export interface TlsPeerEvidenceV1 {
  connectedAddress: string;
  connectedPort: number;
  serverName: string;
  certificateHostnameVerified: boolean;
}

export type IpAddressScopeV1 = "global" | "private" | "loopback" | "link_local" | "multicast" | "documentation" | "unspecified" | "reserved";

function canonicalIpv4(value: string): string | undefined {
  if (isIP(value) !== 4) return undefined;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return undefined;
  return parts.map(Number).join(".");
}

function canonicalIpv6(value: string): string | undefined {
  if (value.includes("%") || isIP(value) !== 6) return undefined;
  try {
    const hostname = new URL(`https://[${value}]:443`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalizeIpAddress(value: string): string {
  const canonical = canonicalIpv4(value) ?? canonicalIpv6(value);
  if (!canonical) throw new TargetGuardError("identity_mismatch");
  return canonical;
}

function ipv6Bytes(canonical: string): number[] {
  const [leftText, rightText] = canonical.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!canonical.includes("::") && missing !== 0)) throw new TargetGuardError("identity_mismatch");
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) throw new TargetGuardError("identity_mismatch");
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >>> 8, value & 0xff];
  });
}

export function classifyIpAddress(value: string): { address: string; version: 4 | 6; scope: IpAddressScopeV1 } {
  const address = canonicalizeIpAddress(value);
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    let scope: IpAddressScopeV1 = "global";
    if (a === 0) scope = "unspecified";
    else if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) scope = "private";
    else if (a === 127) scope = "loopback";
    else if (a === 169 && b === 254) scope = "link_local";
    else if (a >= 224 && a <= 239) scope = "multicast";
    else if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) scope = "documentation";
    else if ((a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19)) || a >= 240) scope = "reserved";
    return { address, version: 4, scope };
  }

  const bytes = ipv6Bytes(address);
  let scope: IpAddressScopeV1 = "reserved";
  if (bytes.every((byte) => byte === 0)) scope = "unspecified";
  else if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) scope = "loopback";
  else if ((bytes[0] & 0xfe) === 0xfc) scope = "private";
  else if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) scope = "link_local";
  else if (bytes[0] === 0xff) scope = "multicast";
  else if ((bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
    || (bytes[0] === 0x3f && (bytes[1] & 0xf0) === 0xf0)) scope = "documentation";
  else if (bytes[0] === 0x20 && bytes[1] === 0x01 && ((bytes[2] < 0x02) || (bytes[2] === 0x02 && bytes[3] === 0x00))) scope = "reserved";
  else if ((bytes[0] & 0xe0) === 0x20) scope = "global";
  return { address, version: 6, scope };
}

export function parseCanonicalHttpsDestination(value: string): CanonicalHttpsDestinationV1 {
  if (!canonicalNetworkDestinationSchema.safeParse(value).success) throw new TargetGuardError("invalid_target");
  const match = /^https:\/\/([^:]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match) throw new TargetGuardError("invalid_target");
  const host = match[1];
  const ipv4 = canonicalIpv4(host);
  return { canonicalDestination: value, host, port: Number(match[2]), hostKind: ipv4 ? "ipv4" : "dns" };
}

function requireCanonicalNow(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    throw new TargetGuardError("invalid_target");
  }
  return value;
}

export async function preparePinnedHttpsConnection(input: {
  canonicalDestination: string;
  allowedDestinations: string[];
  resolver: NetworkResolverV1;
  executor: NetworkExecutorEnforcementV1;
  resolvedAt: string;
}): Promise<PinnedHttpsConnectionPlanV1> {
  if (!input.executor.exposesFinalDestination || !input.executor.supportsPinnedTlsConnection) throw new TargetGuardError("unsupported_executor");
  const destination = parseCanonicalHttpsDestination(input.canonicalDestination);
  if (input.allowedDestinations.length === 0 || new Set(input.allowedDestinations).size !== input.allowedDestinations.length
    || input.allowedDestinations.some((allowed, index) => index > 0 && input.allowedDestinations[index - 1] > allowed)
    || input.allowedDestinations.some((allowed) => !canonicalNetworkDestinationSchema.safeParse(allowed).success)
    || !input.allowedDestinations.includes(destination.canonicalDestination)) throw new TargetGuardError("target_not_allowed");
  const resolvedAt = requireCanonicalNow(input.resolvedAt);
  let rawAddresses: string[];
  try {
    rawAddresses = destination.hostKind === "ipv4" ? [destination.host] : await input.resolver.resolve(destination.host);
  } catch {
    throw new TargetGuardError("target_unavailable");
  }
  if (rawAddresses.length === 0 || rawAddresses.length > 16) throw new TargetGuardError("target_unavailable");
  let classified: Array<ReturnType<typeof classifyIpAddress>>;
  try {
    classified = rawAddresses.map(classifyIpAddress);
  } catch {
    throw new TargetGuardError("identity_mismatch");
  }
  const pinnedAddresses = [...new Set(classified.map(({ address }) => address))].sort();
  const literalAddressException = destination.hostKind === "ipv4";
  if (classified.some(({ address, scope }) => scope !== "global" && !(literalAddressException && address === destination.host))) {
    throw new TargetGuardError("prohibited_address");
  }
  if (literalAddressException && (pinnedAddresses.length !== 1 || pinnedAddresses[0] !== destination.host)) throw new TargetGuardError("identity_mismatch");
  return { ...destination, pinnedAddresses, literalAddressException, resolvedAt };
}

export function verifyPinnedTlsPeer(plan: PinnedHttpsConnectionPlanV1, evidence: TlsPeerEvidenceV1): void {
  let connectedAddress: string;
  try {
    connectedAddress = canonicalizeIpAddress(evidence.connectedAddress);
  } catch {
    throw new TargetGuardError("identity_mismatch");
  }
  if (!plan.pinnedAddresses.includes(connectedAddress)
    || evidence.connectedPort !== plan.port
    || evidence.serverName !== plan.host
    || !evidence.certificateHostnameVerified) throw new TargetGuardError("identity_mismatch");
}

export async function authorizeRedirectHop(input: {
  previousPlan: PinnedHttpsConnectionPlanV1;
  nextCanonicalDestination: string;
  allowedDestinations: string[];
  resolver: NetworkResolverV1;
  executor: NetworkExecutorEnforcementV1;
  resolvedAt: string;
}): Promise<PinnedHttpsConnectionPlanV1> {
  return preparePinnedHttpsConnection({
    canonicalDestination: input.nextCanonicalDestination, allowedDestinations: input.allowedDestinations,
    resolver: input.resolver, executor: input.executor, resolvedAt: input.resolvedAt,
  });
}
