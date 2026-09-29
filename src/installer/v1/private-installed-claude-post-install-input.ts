import { types } from "node:util";
import { exactHostDataArrayV1, exactHostDataSnapshotV1, exactHostUint8ArrayV1 } from
  "../../security/host-value";

const refused = (): never => {
  const error = new Error("private_installed_claude_post_install_input_refused");
  error.stack = undefined;
  throw error;
};

// Hold the intrinsic once. Captured capability wrappers never consult a
// caller-owned function's `bind`, `name`, `length`, or other properties after
// the exact data graph has crossed this boundary.
const applyCallable = Reflect.apply;

/** Capture the owner-held tuple without invoking readers or native ports.
 * Ordinary installation JSON cannot supply these capabilities. Admission and
 * both independent rereads remain the existing runtime assembly's job. */
export function capturePrivateInstalledClaudePostInstallInputV1(value: unknown) {
  const tuple = exactHostDataSnapshotV1(value, ["admissionInput", "admissionRuntime", "compositionInput"]);
  if (!tuple) return refused();
  const readers = exactHostDataSnapshotV1(tuple.admissionRuntime,
    ["readOriginalInstallationHistory", "readTransition"]);
  if (!readers || Object.values(readers).some(reader => typeof reader !== "function" || types.isProxy(reader)))
    return refused();
  const composition = exactHostDataSnapshotV1(tuple.compositionInput,
    ["tenantId", "installedProcessConfiguration", "ports", "execution", "reviewCheckpoints",
      "assertCurrentProcess", "assertCurrentDelivery"]);
  if (!composition) return refused();

  function capture(input: unknown, capabilities: boolean, active = new WeakSet<object>(),
    seen = new WeakMap<object, unknown>(), receiver?: object): unknown {
    if (input === null || input === undefined || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : refused();
    if ((typeof input !== "object" && typeof input !== "function") || types.isProxy(input)) return refused();
    if (typeof input === "function") {
      if (!capabilities) return refused();
      const callable = input;
      return Object.freeze(function capturedInstalledClaudeCapability(...args: unknown[]) {
        return applyCallable(callable, receiver, args);
      });
    }
    if (active.has(input)) return refused();
    const prior = seen.get(input);
    if (prior !== undefined) return prior;
    if (Object.getPrototypeOf(input) === Uint8Array.prototype) {
      const bytes = capabilities ? exactHostUint8ArrayV1(input, 256 * 1024) : undefined;
      if (!bytes) return refused();
      const copied = bytes.copy(); seen.set(input, copied); return copied;
    }
    active.add(input);
    if (Array.isArray(input)) {
      const array = exactHostDataArrayV1(input, 65_536);
      if (!array) return refused();
      const result = array.map(item => capture(item, capabilities, active, seen, input));
      active.delete(input); seen.set(input, result); return Object.freeze(result);
    }
    if (Object.getPrototypeOf(input) !== Object.prototype) return refused();
    const names = Object.getOwnPropertyNames(input);
    if (names.some(name => ["__proto__", "prototype", "constructor"].includes(name))) return refused();
    const data = exactHostDataSnapshotV1(input, names);
    if (!data) return refused();
    const result: Record<string, unknown> = {};
    for (const name of names) result[name] = capture(data[name], capabilities, active, seen, input);
    active.delete(input); seen.set(input, result); return Object.freeze(result);
  }

  return Object.freeze({ admissionInput: capture(tuple.admissionInput, false),
    admissionRuntime: capture(readers, true), compositionInput: capture(composition, true) });
}
