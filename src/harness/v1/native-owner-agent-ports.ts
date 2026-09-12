import { lstat, realpath } from "node:fs/promises";
import { Socket } from "node:net";
import type { OwnerAgentEndpointIdentity } from "./private-owner-agent-endpoint";

/** Native metadata only; never reads socket contents or discovers an agent. */
export async function inspectOwnerAgentPath(path: string): Promise<OwnerAgentEndpointIdentity> {
  const fail = (): never => { throw new Error("owner_agent_endpoint_unavailable"); };
  if (process.platform === "win32") return fail();
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink()) return fail();
    const canonicalPath = await realpath(path), after = await lstat(path);
    if (canonicalPath !== path || before.dev !== after.dev || before.ino !== after.ino
      || before.uid !== after.uid || before.mode !== after.mode || after.isSymbolicLink()) return fail();
    return Object.freeze({ canonicalPath, kind: after.isDirectory() ? "directory" : after.isSocket() ? "socket" : "other",
      uid: after.uid, mode: after.mode, device: after.dev, inode: after.ino });
  } catch { return fail(); }
}

/** Explicit effect port, unwired. Call only after endpoint admission and owner
 * authorization. Construction does not connect; the returned function does.
 * A trusted injected socket factory supports effect-free tests.
 */
export function createOwnerAgentSocketPort(makeSocket: () => Socket = () => new Socket()) {
  return (path: string): { stream: Socket; connected: Promise<void> } => {
    const stream = makeSocket();
    let rejectConnection!: () => void;
    const connected = new Promise<void>((resolve, reject) => {
      rejectConnection = () => reject(new Error("owner_signature_unavailable"));
      stream.once("connect", resolve);
      stream.on("error", rejectConnection);
      stream.once("close", rejectConnection);
      stream.once("end", rejectConnection);
    });
    void connected.catch(() => {});
    try { stream.connect(path); }
    catch {
      rejectConnection();
      try { stream.destroy(); } catch { /* caller receives failure, never a usable stream */ }
      throw new Error("owner_signature_unavailable");
    }
    return { stream, connected };
  };
}
