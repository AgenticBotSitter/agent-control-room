import { types as nodeUtilTypes } from "node:util";

const isProxy = nodeUtilTypes.isProxy;
const objectGetPrototypeOf = Object.getPrototypeOf;
const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const arrayBufferPrototype = ArrayBuffer.prototype;
const uint8ArrayConstructor = Uint8Array;
const uint8ArrayPrototype = Uint8Array.prototype;
const typedArrayPrototype = objectGetPrototypeOf(uint8ArrayPrototype);
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(arrayBufferPrototype, "byteLength")?.get;
const arrayBufferDetachedGetter = Object.getOwnPropertyDescriptor(arrayBufferPrototype, "detached")?.get;
const uint8ArrayAt = uint8ArrayPrototype.at;
const uint8ArrayFill = uint8ArrayPrototype.fill;
const uint8ArraySet = uint8ArrayPrototype.set;

if (!typedArrayBufferGetter || !typedArrayByteLengthGetter || !typedArrayByteOffsetGetter
  || !typedArrayLengthGetter || !arrayBufferByteLengthGetter || !arrayBufferDetachedGetter) throw new Error("host binary intrinsics unavailable");

/**
 * Node's host-level Proxy check does not consult the value's traps. Security
 * boundaries must call this before reflection, property access, iteration, or
 * cloning an object supplied by another component.
 */
export function isHostProxyV1(value: unknown): boolean {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && isProxy(value);
}

/** Read one own data property without invoking accessors or Proxy traps. */
export function ownDataPropertyValueV1(value: unknown, key: PropertyKey): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function") || isHostProxyV1(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Read a data property without invoking accessors, including class methods. */
export function dataPropertyValueV1(value: unknown, key: PropertyKey): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  let current: object | null = value;
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (isHostProxyV1(current)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/** Capture a callable data property while excluding callable Proxies. */
export function dataMethodV1(value: unknown, key: PropertyKey): ((...args: unknown[]) => unknown) | undefined {
  const method = dataPropertyValueV1(value, key);
  return typeof method === "function" && !isHostProxyV1(method) ? method as (...args: unknown[]) => unknown : undefined;
}

/**
 * Copy a bounded exact ordinary-data object without executing object behavior.
 * Optional keys may be absent; every present property must be enumerable data.
 */
export function exactHostDataSnapshotV1(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
  options: { allowNullPrototype?: boolean } = {},
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && !(options.allowNullPrototype && prototype === null)) return undefined;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (allowed.size !== requiredKeys.length + optionalKeys.length) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
  const present = new Set(ownKeys as string[]);
  if (requiredKeys.some((key) => !present.has(key))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value), snapshot: Record<string, unknown> = {};
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) return undefined;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** Snapshot an exact dense ordinary array without iteration or property reads. */
export function exactHostDataArrayV1(value: unknown, maximum: number): unknown[] | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) return undefined;
  const length = lengthDescriptor.value as number, ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return undefined;
  const expected = [...Array.from({ length }, (_, index) => String(index)), "length"].sort();
  if ((ownKeys as string[]).sort().join("\0") !== expected.join("\0")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value), result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) return undefined;
    result.push(descriptor.value);
  }
  return result;
}

export interface ExactHostUint8ArrayV1 {
  readonly byteLength: number;
  byteAt(index: number): number | undefined;
  copy(length?: number): Uint8Array;
  wipe(): void;
}

/**
 * Observe an exact Uint8Array through captured native intrinsics only. This
 * rejects shared/detached or partial backing stores, subclasses, prototype
 * drift, and any own property that could shadow metadata without executing it.
 */
export function exactHostUint8ArrayV1(value: unknown, maximum: number): ExactHostUint8ArrayV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value)
    || !Number.isSafeInteger(maximum) || maximum < 0) return undefined;
  try {
    const buffer = reflectApply(typedArrayBufferGetter!, value, []) as ArrayBuffer;
    const byteLength = reflectApply(typedArrayByteLengthGetter!, value, []) as number;
    const byteOffset = reflectApply(typedArrayByteOffsetGetter!, value, []) as number;
    const length = reflectApply(typedArrayLengthGetter!, value, []) as number;
    const bufferByteLength = reflectApply(arrayBufferByteLengthGetter!, buffer, []) as number;
    const detached = reflectApply(arrayBufferDetachedGetter!, buffer, []) as boolean;
    if (objectGetPrototypeOf(value) !== uint8ArrayPrototype
      || objectGetPrototypeOf(buffer) !== arrayBufferPrototype || reflectOwnKeys(buffer).length !== 0
      || byteLength !== length
      || detached
      || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximum
      || byteOffset !== 0 || byteLength !== bufferByteLength) return undefined;
    const keys = reflectOwnKeys(value);
    if (keys.length !== length || keys.some((key, index) => key !== String(index))) return undefined;
    const typedValue = value as Uint8Array;
    return Object.freeze({
      byteLength,
      byteAt(index: number) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= byteLength) return undefined;
        return reflectApply(uint8ArrayAt, typedValue, [index]) as number;
      },
      copy(copyLength: number = byteLength) {
        if (!Number.isSafeInteger(copyLength) || copyLength < 0 || copyLength > byteLength) throw new Error("binary copy length invalid");
        const source = new uint8ArrayConstructor(buffer, byteOffset, copyLength), copy = new uint8ArrayConstructor(copyLength);
        reflectApply(uint8ArraySet, copy, [source]);
        return copy;
      },
      wipe() {
        const wholeBuffer = new uint8ArrayConstructor(buffer);
        reflectApply(uint8ArrayFill, wholeBuffer, [0]);
      },
    });
  } catch { return undefined; }
}

/** Wipe an actual Uint8Array through its intrinsic, even when its shape is invalid. */
export function wipeHostUint8ArrayV1(value: unknown): boolean {
  if (!value || typeof value !== "object" || isHostProxyV1(value)) return false;
  try {
    const buffer = reflectApply(typedArrayBufferGetter!, value, []) as ArrayBufferLike;
    const wholeBuffer = new uint8ArrayConstructor(buffer);
    reflectApply(uint8ArrayFill, wholeBuffer, [0]);
    return true;
  } catch { return false; }
}

export interface HostResultCollectorV1 { submit(value: unknown): void; }

/**
 * A broker-owned synchronous handoff prevents Promise thenable assimilation from
 * touching an untrusted result before the host can reject a Proxy.
 */
export function createHostResultCollectorV1(): {
  collector: HostResultCollectorV1;
  take(): unknown;
  /** Close the collector and return any first accepted value for safe cleanup. */
  abort(): unknown;
} {
  let state: "open" | "submitted" | "invalid" | "closed" = "open", result: unknown;
  const collector = Object.freeze({ submit(value: unknown) {
    if (state !== "open") { state = "invalid"; throw new Error("result collector conflict"); }
    if (isHostProxyV1(value)) { state = "invalid"; throw new Error("Proxy result rejected"); }
    result = value; state = "submitted";
  } });
  return {
    collector,
    take() { if (state !== "submitted") { state = "closed"; throw new Error("result collector incomplete"); } const value = result; state = "closed"; result = undefined; return value; },
    abort() { const value = result; state = "closed"; result = undefined; return value; },
  };
}
