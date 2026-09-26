import { types } from "node:util";
import { PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1,
  type PrivateInstallationJournalNativeCustodyPreparationV1,
  type PrivateInstallationJournalNativeOperationRequestV1 } from
  "./private-installation-journal-native-custody-preparation";
import type { InstallationPlanJournalEntryIdentityV1,
  InstallationPlanJournalEntryV1,
  InstallationPlanJournalReadEntryV1,
  InstallationPlanJournalStorageSessionFactoryV1,
  InstallationPlanJournalStorageSessionV1 } from "./installation-plan-journal-storage-session";

export const PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1 =
  "control-room.private-installation-journal-held-session-port/v1" as const;
export const PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1 =
  "control-room.private-installation-journal-held-session/v1" as const;

export type PrivateInstallationJournalHeldSessionV1 = InstallationPlanJournalStorageSessionV1 & Readonly<{
  schema: typeof PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1;
  operationId: string;
}>;

export type PrivateInstallationJournalHeldSessionPortV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1;
  openSession(request: PrivateInstallationJournalNativeOperationRequestV1):
    Promise<PrivateInstallationJournalHeldSessionV1>;
}>;

type Input = Readonly<{
  preparation: Pick<PrivateInstallationJournalNativeCustodyPreparationV1, "prepareOperation">;
  nativePort: PrivateInstallationJournalHeldSessionPortV1;
}>;

const uncertain = (): Error => {
  const error = new Error("private_installation_journal_held_session_uncertain"); error.stack = undefined; return error;
};
const fail = (): never => { throw uncertain(); };

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return fail();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(name => !names.includes(name))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))) return fail();
  for (const name of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return fail();
  }
  return value as Readonly<Record<string, unknown>>;
}

function capture(inputValue: unknown) {
  const input = exact(inputValue, ["preparation", "nativePort"]);
  if (!input.preparation || typeof input.preparation !== "object" || types.isProxy(input.preparation)
    || !input.nativePort || typeof input.nativePort !== "object" || types.isProxy(input.nativePort)) return fail();
  const prepareDescriptor = Object.getOwnPropertyDescriptor(input.preparation, "prepareOperation");
  const port = exact(input.nativePort, ["schema", "openSession"]);
  if (!prepareDescriptor || !("value" in prepareDescriptor) || typeof prepareDescriptor.value !== "function"
    || port.schema !== PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1 || typeof port.openSession !== "function") return fail();
  return Object.freeze({
    prepareOperation: (prepareDescriptor.value as PrivateInstallationJournalNativeCustodyPreparationV1["prepareOperation"])
      .bind(input.preparation),
    openSession: (port.openSession as PrivateInstallationJournalHeldSessionPortV1["openSession"]).bind(input.nativePort),
  });
}

const identityMatches = (left: InstallationPlanJournalEntryIdentityV1,
  right: InstallationPlanJournalEntryIdentityV1) => left.device === right.device && left.inode === right.inode;

function identitySnapshot(value: unknown): InstallationPlanJournalEntryIdentityV1 {
  const record = exact(value, ["device", "inode"]);
  if (typeof record.device !== "bigint" || record.device < BigInt(0)
    || typeof record.inode !== "bigint" || record.inode < BigInt(0)) return fail();
  return Object.freeze({ device: record.device, inode: record.inode });
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return fail();
  return value as number;
}

function entrySnapshot(value: unknown): InstallationPlanJournalEntryV1 {
  const record = exact(value, ["identity", "kind", "ownerUid", "mode", "linkCount", "size", "canonical"]);
  if (record.kind !== "file" && record.kind !== "directory" && record.kind !== "other") return fail();
  if (typeof record.canonical !== "boolean") return fail();
  return Object.freeze({ identity: identitySnapshot(record.identity), kind: record.kind,
    ownerUid: safeInteger(record.ownerUid, 0x7fffffff), mode: safeInteger(record.mode, 0o7777),
    linkCount: safeInteger(record.linkCount), size: safeInteger(record.size), canonical: record.canonical });
}

function readSnapshot(value: unknown, maximumBytes: number): InstallationPlanJournalReadEntryV1 {
  const record = exact(value, ["entry", "bytes"]);
  if (types.isProxy(record.bytes) || !(record.bytes instanceof Uint8Array)
    || Object.getPrototypeOf(record.bytes) !== Uint8Array.prototype
    || Object.getOwnPropertySymbols(record.bytes).length !== 0
    || (typeof SharedArrayBuffer !== "undefined" && record.bytes.buffer instanceof SharedArrayBuffer)
    || record.bytes.byteLength < 1 || record.bytes.byteLength > maximumBytes) return fail();
  const entry = entrySnapshot(record.entry), bytes = Uint8Array.from(record.bytes);
  if (entry.size !== bytes.byteLength) return fail();
  return Object.freeze({ entry, bytes });
}

function namesSnapshot(value: unknown): readonly string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return fail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > 10_000) return fail();
  const result: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true
      || typeof descriptor.value !== "string" || descriptor.value.length > 255) return fail();
    result.push(descriptor.value);
  }
  if (Object.getOwnPropertyNames(value).length !== result.length + 1) return fail();
  return Object.freeze(result);
}

function boundedName(name: string, installationId: string): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 255 || name.includes("/") || name.includes("\0")
    || Buffer.byteLength(name, "utf8") > 255) return fail();
  const escaped = installationId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const grammar = new RegExp(`^${escaped}\\.installation-plan\\.revision-\\d{10}(?:\\.json|\\.publish\\.json|\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp)$`, "u");
  if (!grammar.test(name)) return fail();
  return name;
}

function maximumForName(name: string): number { return name.endsWith(".publish.json") ? 1_024 : 65_536; }
function revisionOf(name: string): string {
  const match = /\.installation-plan\.revision-(\d{10})/u.exec(name); if (!match) return fail(); return match[1]!;
}

async function untilDeadline<T>(promise: Promise<T>, request: PrivateInstallationJournalNativeOperationRequestV1):
Promise<T> {
  if (request.signal.aborted || Date.now() >= request.deadlineUnixMs) return fail();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(uncertain()), Math.max(0, request.deadlineUnixMs - Date.now()));
  });
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(uncertain()); request.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([promise, deadline, aborted]); }
  finally {
    clearTimeout(timer);
    if (rejectAbort) request.signal.removeEventListener("abort", rejectAbort);
  }
}

const sessionFields = ["schema", "operationId", "operation", "listEntryNames", "statEntry", "readEntry",
  "createExclusiveEntry", "writeExactBounded", "syncFile", "linkNoReplace", "unlinkExact", "syncDirectory",
  "verifyRoot", "close"] as const;

/**
 * Adapts a separately reviewed held native session to the retained journal's
 * storage seam. It supplies no filesystem fallback and narrows every call to
 * the operation capabilities, basename grammar, byte ceilings and deadline in
 * the prepared request.
 */
export function createPrivateInstallationJournalHeldSessionAdapterV1(inputValue: unknown):
InstallationPlanJournalStorageSessionFactoryV1 {
  const captured = capture(inputValue);
  return async open => {
    const signal = open.signal ?? new AbortController().signal;
    const request = captured.prepareOperation(open.operation, signal);
    const now = Date.now();
    if (request.schema !== PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1 || request.operation !== open.operation
      || request.journalRootPath !== open.rootDirectory
      || request.installationId !== open.installationId || request.expectedOwnerUid !== open.ownerUid
      || request.signal !== signal || !Number.isSafeInteger(request.deadlineUnixMs)
      || request.deadlineUnixMs <= now || request.deadlineUnixMs > now + 30_000
      || request.expectedRootMode !== 0o700 || request.maximumPlanBytes !== 65_536
      || request.maximumWitnessBytes !== 1_024 || request.maximumRevisions !== 10_000
      || request.mayAppend !== (open.operation === "append")
      || request.mayMutateForRecovery !== (open.operation !== "inspect_settled_history")
      || request.recoveryScope !== (open.operation === "inspect_settled_history" ? "none" : "retained_publication_only"))
      return fail();
    const opening = captured.openSession(request);
    let raw: unknown;
    try { raw = await untilDeadline(opening, request); }
    catch {
      void opening.then(session => session.close()).catch(() => {});
      return fail();
    }
    let value: Readonly<Record<string, unknown>>;
    let methods: InstallationPlanJournalStorageSessionV1;
    try {
      value = exact(raw, sessionFields);
      if (value.schema !== PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1 || value.operationId !== request.operationId
        || value.operation !== request.operation) return fail();
      methods = Object.fromEntries(sessionFields.slice(3).map(name => {
        if (typeof value[name] !== "function") return fail();
        return [name, (value[name] as (...args: never[]) => unknown).bind(raw)];
      })) as unknown as InstallationPlanJournalStorageSessionV1;
    }
    catch {
      if (raw && typeof raw === "object") {
        const close = Object.getOwnPropertyDescriptor(raw, "close");
        if (close && "value" in close && typeof close.value === "function")
          void Promise.resolve().then(() => close.value.call(raw)).catch(() => {});
      }
      return fail();
    }
    let closed = false, terminal = false, directorySyncs = 0;
    const created = new Map<string, { identity: InstallationPlanJournalEntryIdentityV1; state: "created" | "written" | "synced";
      syncOrdinal?: number }>();
    const call = async <T>(invoke: () => Promise<T>, permitsExists = false): Promise<T> => {
      if (closed || terminal || request.signal.aborted || Date.now() >= request.deadlineUnixMs) {
        terminal = true; return fail();
      }
      try {
        const result = await untilDeadline(invoke(), request);
        if (request.signal.aborted) return fail();
        return result;
      } catch (error) {
        if (permitsExists && (error as NodeJS.ErrnoException).code === "EEXIST") throw error;
        terminal = true; return fail();
      }
    };
    const mutation = () => {
      if (request.operation === "inspect_settled_history") return fail();
    };
    const session: InstallationPlanJournalStorageSessionV1 = Object.freeze({
      operation: request.operation,
      async listEntryNames() {
        return namesSnapshot(await call(() => methods.listEntryNames()));
      },
      async statEntry(name) {
        const checked = boundedName(name, request.installationId), result = await call(() => methods.statEntry(checked));
        return result === undefined ? undefined : entrySnapshot(result);
      },
      async readEntry(name, maximumBytes) {
        const checked = boundedName(name, request.installationId), ceiling = maximumForName(checked);
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > ceiling) return fail();
        return readSnapshot(await call(() => methods.readEntry(checked, maximumBytes)), maximumBytes);
      },
      async createExclusiveEntry(name) {
        if (request.operation !== "append") return fail();
        const checked = boundedName(name, request.installationId);
        if ((!checked.endsWith(".tmp") && !checked.endsWith(".publish.json")) || created.has(checked)) return fail();
        const result = identitySnapshot(await call(() => methods.createExclusiveEntry(checked), true));
        created.set(checked, { identity: result, state: "created" }); return result;
      },
      async writeExactBounded(name, identity, bytes, maximumBytes) {
        if (request.operation !== "append") return fail();
        const checked = boundedName(name, request.installationId), held = created.get(checked), ceiling = maximumForName(checked);
        const suppliedIdentity = identitySnapshot(identity);
        if (!held || held.state !== "created" || !identityMatches(held.identity, suppliedIdentity)
          || types.isProxy(bytes) || !(bytes instanceof Uint8Array)
          || bytes.byteLength < 1 || bytes.byteLength > ceiling || maximumBytes !== ceiling) return fail();
        const copy = Uint8Array.from(bytes);
        const result = await call(() => methods.writeExactBounded(checked, held.identity, copy, maximumBytes));
        if (result !== undefined) return fail(); held.state = "written";
      },
      async syncFile(name, identity) {
        if (request.operation !== "append") return fail();
        const checked = boundedName(name, request.installationId), held = created.get(checked);
        const suppliedIdentity = identitySnapshot(identity);
        if (!held || held.state !== "written" || !identityMatches(held.identity, suppliedIdentity)) return fail();
        const result = await call(() => methods.syncFile(checked, held.identity));
        if (result !== undefined) return fail(); held.state = "synced"; held.syncOrdinal = directorySyncs;
      },
      async linkNoReplace(sourceName, identity, targetName) {
        if (request.operation !== "append") return fail();
        const source = boundedName(sourceName, request.installationId), target = boundedName(targetName, request.installationId);
        const revision = revisionOf(source), held = created.get(source);
        const witness = [...created.entries()].find(([name]) => name.endsWith(".publish.json")
          && revisionOf(name) === revision)?.[1];
        if (!source.endsWith(".tmp") || !target.endsWith(".json") || target.endsWith(".publish.json")
          || revisionOf(target) !== revision
          || !held || held.state !== "synced" || !identityMatches(held.identity, identitySnapshot(identity))
          || !witness || witness.state !== "synced" || directorySyncs <= (witness.syncOrdinal ?? directorySyncs)) return fail();
        const result = await call(() => methods.linkNoReplace(source, held.identity, target), true);
        if (result !== undefined) return fail();
      },
      async unlinkExact(name, identity, allowMissing = false) {
        mutation(); const checked = boundedName(name, request.installationId);
        if ((!checked.endsWith(".tmp") && !checked.endsWith(".publish.json")) || typeof allowMissing !== "boolean") return fail();
        const result = await call(() => methods.unlinkExact(checked, identitySnapshot(identity), allowMissing));
        if (result !== undefined) return fail();
      },
      async syncDirectory() {
        mutation(); const result = await call(() => methods.syncDirectory());
        if (result !== undefined) return fail(); directorySyncs += 1;
      },
      async verifyRoot() {
        const result = await call(() => methods.verifyRoot()); if (result !== undefined) return fail();
      },
      async close() {
        if (closed) return fail(); closed = true;
        const closing = methods.close();
        try { if (await untilDeadline(closing, request) !== undefined) return fail(); }
        catch { void closing.catch(() => {}); terminal = true; return fail(); }
      },
    });
    return session;
  };
}
