import { posix } from "node:path";

export interface OwnerAgentEndpointIdentity {
  canonicalPath: string;
  kind: "directory" | "socket" | "other";
  uid: number;
  mode: number;
  device: number;
  inode: number;
}

/** Explicit POSIX endpoint policy. Does not discover SSH_AUTH_SOCK or authorize
 * signing. The caller must separately own the stream, pin the key, and obtain
 * trusted consent. Filesystem checks are observations, not an atomic connect.
 */
export function createPrivateOwnerAgentEndpoint(config: { socketPath: string; ownerUid: number },
  inspect: (path: string) => Promise<OwnerAgentEndpointIdentity>) {
  const fail = (): never => { throw new Error("owner_agent_endpoint_unavailable"); };
  const { socketPath, ownerUid } = config;
  if (typeof socketPath !== "string" || !socketPath.startsWith("/") || socketPath.includes("\0")
    || socketPath.includes("\\") || posix.normalize(socketPath) !== socketPath
    || posix.dirname(socketPath) === "/" || !Number.isSafeInteger(ownerUid) || ownerUid < 0) fail();
  const parent = posix.dirname(socketPath);
  function validate(value: OwnerAgentEndpointIdentity, path: string, kind: "directory" | "socket") {
    if (!value || value.canonicalPath !== path || value.kind !== kind || value.uid !== ownerUid
      || !Number.isSafeInteger(value.mode) || value.mode < 0 || (value.mode & 0o077) !== 0
      || (value.mode & 0o7000) !== 0
      || !Number.isSafeInteger(value.device) || value.device < 0
      || !Number.isSafeInteger(value.inode) || value.inode < 1
      || (kind === "directory" ? (value.mode & 0o700) !== 0o700 : (value.mode & 0o600) !== 0o600)) fail();
    return Object.freeze({ ...value });
  }
  const check = (signal: AbortSignal) => { if (signal.aborted) fail(); };
  async function capture(signal: AbortSignal) {
    check(signal);
    const directory = validate(await inspect(parent), parent, "directory"); check(signal);
    const socket = validate(await inspect(socketPath), socketPath, "socket"); check(signal);
    const again = validate(await inspect(parent), parent, "directory"); check(signal);
    if (directory.device !== again.device || directory.inode !== again.inode) fail();
    return Object.freeze({ directory, socket });
  }
  return Object.freeze({ socketPath, async prepare(signal: AbortSignal) {
    let baseline: Awaited<ReturnType<typeof capture>>;
    try { baseline = await capture(signal); } catch { return fail(); }
    return Object.freeze({ async recheck() {
      try {
        const current = await capture(signal);
        for (const part of ["directory", "socket"] as const) {
          if (current[part].device !== baseline[part].device || current[part].inode !== baseline[part].inode) fail();
        }
      } catch { fail(); }
    } });
  } });
}
