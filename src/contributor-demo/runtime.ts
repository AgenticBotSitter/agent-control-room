import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createControlRoomLocalPilotRuntimeV1 } from "../local-pilot/v1/runtime";
import { sha256Digest } from "../security";
import { createContributorSimulations } from "./simulations";
import type { ContributorRevision } from "./revision";

/** Disposable contributor composition, not an operational startup entry.
 * Does not read environment credentials, access Keychain, start a listener or accept
 * native drivers. The caller must display the one-time code privately and close the
 * handle on shutdown. Abrupt process termination can leave disposable data behind.
 */
export async function createContributorDemoRuntime(repositoryRoot: string) {
  if (!isAbsolute(repositoryRoot)) throw new Error("demo_repository_root_must_be_absolute");
  const dataDir = await mkdtemp(join(tmpdir(), "control-room-contributor-demo-"));
  const ownerCode = randomBytes(24).toString("base64url");
  const masterKey = randomBytes(32);
  const simulations = createContributorSimulations();
  try {
    const runtime = await createControlRoomLocalPilotRuntimeV1({
      repositoryRoot, dataDir, mode: "repository_fake", origin: "http://127.0.0.1:3000",
      masterKey, ownerCodeDigest: sha256Digest({ code: ownerCode }),
      syntheticResults: simulations.source,
    });
    let closing: Promise<void> | undefined;
    return Object.freeze({
      simulationOnly: true as const,
      origin: "http://127.0.0.1:3000" as const,
      dataDir,
      ownerCode,
      runtime,
      simulationHistory: (request: Request, projectId: string, jobId: string) => simulations.history(runtime, request, projectId, jobId),
      simulate: (request: Request, projectId: string, jobId: string, revision?: ContributorRevision) => simulations.start(runtime, request, projectId, jobId, revision),
      close(): Promise<void> {
        // Do not remove a database that failed to close. Retain the exact path so
        // the caller can report cleanup failure without erasing recovery evidence.
        return closing ??= (async () => {
          await simulations.close();
          await runtime.close();
          await rm(dataDir, { recursive: true, force: true });
        })();
      },
    });
  } catch (error) {
    await simulations.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  } finally {
    masterKey.fill(0);
  }
}
