import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { SqliteBridgeJournal } from "./journal";
import { SqliteNativeRunJournal } from "../harness/hermes-native-v1/run-journal";
import { SqliteLocalAdmissionStore } from "../node-policy/v1/admission-store";
import { SqliteExecutionStateStore } from "../node-policy/v1/execution-state-store";
import { SqliteEffectClaimStore } from "../node-policy/v1/effect-claim-store";
import { PinnedApprovalTrustStore } from "../node-policy/v1/pinned-approval-trust";
import type { SqliteNodeSecurityStateRepository } from "../node-policy/v1/persistent-security-state";
import type { NodePrivateKeyStore } from "../node-policy/v1/stores";
import { ProtectedStoreFrameSigner } from "./protected-store-signer";
import { NodeProtocolAuthenticator, FixedWindowProtocolRateLimiter } from "../node-protocol/v1";
import { createNativeCurrentPolicy } from "../harness/hermes-native-v1/current-policy";
import { createNativeCurrentRecoveryPolicy } from "../harness/hermes-native-v1/current-recovery-policy";
import { createNativeProfileEvidence } from "../harness/hermes-native-v1/profile-evidence";
import { createNativeHttpsTransport } from "../harness/hermes-native-v1/https-transport";
import { validateNativeNodeRuntimeConfiguration, type NativeNodeRuntimeConfiguration,
  type NativeNodeRuntimeDependencies } from "../harness/hermes-native-v1/node-runtime";
import type { NativeNodeHttpsConfiguration } from "./native-https-client";
import type { NativeConnectorSettings, createNativeHttpsConnector } from "./native-connector";

const pathSchema = z.object({ bridge: z.string(), runs: z.string(), admissions: z.string(), executions: z.string(), effects: z.string() }).strict();
export type PrivateNativeStatePaths = z.infer<typeof pathSchema>;
export interface PrivateNativeConfigurationInput {
  paths: PrivateNativeStatePaths;
  node: NativeNodeRuntimeConfiguration;
  policy: Parameters<typeof createNativeCurrentPolicy>[0];
  approvalPins: unknown;
  profileAcceptance: unknown;
  https: NativeNodeHttpsConfiguration;
  settings: NativeConnectorSettings;
}
export interface PrivateNativeConfigurationPorts {
  /** Already provisioned, verified security state and already selected key custody.
   * Borrowed, never provisioned, unlocked, locked or disposed by this factory. */
  security: SqliteNodeSecurityStateRepository;
  keys: NodePrivateKeyStore;
  serverKeys: ConstructorParameters<typeof NodeProtocolAuthenticator>[0];
  localPaused: () => boolean;
  readSupervisedState: Parameters<typeof createNativeProfileEvidence>[1]["readSupervisedState"];
  readLocalRecoveryState: Parameters<typeof createNativeCurrentRecoveryPolicy>[1]["readLocalState"];
  hermesCredential: Parameters<typeof createNativeHttpsTransport>[1];
  connector: Parameters<typeof createNativeHttpsConnector>[3];
  clock: () => number;
}
const fail = () => new Error("private_native_configuration_unavailable");

/** Require pre-created private files; do not create directories, follow symlinks,
 * repair modes or erase prior state. Protect SQLite sidecars as well as main files.
 * These POSIX ownership checks are not containment against same-UID/admin changes. */
export function validatePrivateNativeStatePaths(value: unknown): PrivateNativeStatePaths {
  const paths = pathSchema.parse(value), names = Object.values(paths);
  if (typeof process.getuid !== "function" || new Set(names).size !== names.length) throw fail();
  const uid = process.getuid(), identities = new Set<string>();
  const inspect = (path: string, optional = false) => {
    if (!isAbsolute(path) || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw fail();
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw fail();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077)
      || realpathSync(path) !== path) throw fail();
    const identity = `${stat.dev}:${stat.ino}`;
    if (identities.has(identity)) throw fail(); identities.add(identity);
  };
  for (const path of names) {
    const directory = dirname(path), stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) || realpathSync(directory) !== directory) throw fail();
    inspect(path);
    for (const suffix of ["-wal", "-shm", "-journal"]) inspect(path + suffix, true);
  }
  return paths;
}

/** Opens only approved local durable journals and composes existing policy/readers.
 * No native request, credential lookup, key operation, lease/ceiling adoption,
 * profile qualification or active-node initialization. The caller must drain the
 * runtime before closing this owner; supplied security/key/credential ports remain
 * caller-owned. No rollback deletes retained files, even on partial setup failure. */
export function openPrivateNativeConfiguration(value: PrivateNativeConfigurationInput,
  ports: PrivateNativeConfigurationPorts, signal: AbortSignal) {
  if (!(signal instanceof AbortSignal) || signal.aborted) throw fail();
  const input = structuredClone(value), node = validateNativeNodeRuntimeConfiguration(input.node);
  const paths = validatePrivateNativeStatePaths(input.paths);
  const clock = ports.clock.bind(ports), paused = ports.localPaused.bind(ports);
  const supervised = ports.readSupervisedState.bind(ports), recoveryState = ports.readLocalRecoveryState.bind(ports);
  const credential = ports.hermesCredential.bind(ports), connector = {
    ...ports.connector, credential: ports.connector.credential.bind(ports.connector),
    assertCurrent: ports.connector.assertCurrent.bind(ports.connector),
    ...(ports.connector.clock ? { clock: ports.connector.clock.bind(ports.connector) } : {}),
    ...(ports.connector.wait ? { wait: ports.connector.wait.bind(ports.connector) } : {}),
  };
  const policy = input.policy;
  if (policy.serverActorId !== node.serverId || policy.request === undefined) throw fail();
  const closeCallbacks: (() => void)[] = [];
  let closed = false, closeError: Error | undefined;
  const close = () => {
    if (closed) { if (closeError) throw closeError; return; } closed = true; let failed = false;
    for (const callback of closeCallbacks.reverse()) { try { callback(); } catch { failed = true; } }
    if (failed) { closeError = new Error("private_native_configuration_cleanup_uncertain"); throw closeError; }
  };
  const own = <T extends { close(): void }>(resource: T): T => {
    closeCallbacks.push(resource.close.bind(resource)); return resource;
  };
  try {
    const journal = own(new SqliteBridgeJournal(paths.bridge)), runs = own(new SqliteNativeRunJournal(paths.runs));
    const admissions = own(new SqliteLocalAdmissionStore(paths.admissions));
    const executions = own(new SqliteExecutionStateStore(paths.executions)), effects = own(new SqliteEffectClaimStore(paths.effects));
    const security = ports.security, keys = ports.keys;
    const approvals = own(new PinnedApprovalTrustStore(input.approvalPins, { security, clock }));
    const binding = approvals.binding();
    if (binding.tenantId !== node.enrollment.tenantId || binding.nodeId !== node.enrollment.nodeId
      || binding.nodeClass !== policy.nodeClass || keys.reference().keyId !== node.nodeKeyId) throw fail();
    const readCurrent = createNativeCurrentPolicy(policy, { security, approvals, journal, effects, keys, localPaused: paused, clock });
    const assertProfileCurrent = createNativeProfileEvidence({ enrollment: node.enrollment, acceptance: input.profileAcceptance },
      { security, approvals, readSupervisedState: supervised, clock });
    const request = policy.request as { approval?: { body?: { approvalKeyId?: string } } };
    const readRecovery = createNativeCurrentRecoveryPolicy({ enrollment: node.enrollment, nodeClass: policy.nodeClass,
      approvalKeyId: request.approval?.body?.approvalKeyId ?? "" }, { security, approvals, readLocalState: recoveryState });
    const current = () => { if (closed || signal.aborted) throw fail(); connector.assertCurrent(); };
    const dependencies: NativeNodeRuntimeDependencies = { journal, runs, approvals, security, clock,
      signer: new ProtectedStoreFrameSigner(keys),
      serverAuthenticator: new NodeProtocolAuthenticator(ports.serverKeys, journal, new FixedWindowProtocolRateLimiter(120, 60)),
      local: { readCurrent, assertProfileCurrent, admissions, executions, effects, clock },
      recovery: { readCurrent: readRecovery, assertProfileCurrent },
      transport: createNativeHttpsTransport(node.enrollment, credential, undefined, clock),
    };
    if (signal.aborted) throw fail();
    return Object.freeze({ harness: "hermes-native-v1" as const, node, dependencies,
      https: input.https, settings: input.settings, sources: { ...connector, assertCurrent: current }, close });
  } catch {
    close(); throw fail();
  }
}
