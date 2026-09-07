import { classifyIpAddress, parseCanonicalHttpsDestination, preparePinnedHttpsConnection,
  type NetworkResolverV1, type PinnedHttpsConnectionPlanV1 } from "../node-policy/v1/network-target-guard";

/** This exception belongs only to the operator-configured machine connector, never
 * to task destinations. DNS, dial address and certificate identity remain pinned. */
export function captureNativePrivateAddress(destination: string, value?: string): string | undefined {
  const target = parseCanonicalHttpsDestination(destination);
  if (value === undefined) return undefined;
  const address = classifyIpAddress(value);
  const parts = address.address.split(".").map(Number);
  const tailnet = address.version === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  if (target.hostKind !== "dns" || address.address !== value || !(address.scope === "private" || tailnet))
    throw new Error("native_node_https_unavailable");
  return address.address;
}

export async function prepareNativeHttpsDestination(destination: string, privateAddress: string | undefined,
  resolver: NetworkResolverV1, resolvedAt: string): Promise<PinnedHttpsConnectionPlanV1> {
  const pinned = captureNativePrivateAddress(destination, privateAddress);
  if (pinned === undefined) return preparePinnedHttpsConnection({ canonicalDestination: destination,
    allowedDestinations: [destination], resolver, resolvedAt,
    executor: { exposesFinalDestination: true, supportsPinnedTlsConnection: true } });
  const target = parseCanonicalHttpsDestination(destination);
  const answers = await resolver.resolve(target.host);
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 16
    || answers.some(value => classifyIpAddress(value).address !== pinned)) throw new Error("native_node_https_unavailable");
  return { ...target, pinnedAddresses: [pinned], literalAddressException: false, resolvedAt };
}
