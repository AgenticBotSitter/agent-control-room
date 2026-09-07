import { NODE_PROTOCOL_SUPPORTED_VERSIONS, type NodeProtocolVersion } from "./types";

export class ProtocolNegotiationError extends Error {
  constructor() {
    super("No mutually supported node protocol version");
    this.name = "ProtocolNegotiationError";
  }
}

export function negotiateProtocolVersion(
  remoteVersions: readonly string[],
  localVersions: readonly NodeProtocolVersion[] = NODE_PROTOCOL_SUPPORTED_VERSIONS,
): NodeProtocolVersion {
  const remote = new Set(remoteVersions);
  const selected = localVersions.find((version) => remote.has(version));
  if (!selected) throw new ProtocolNegotiationError();
  return selected;
}
