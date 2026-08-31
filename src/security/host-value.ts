import { types as nodeUtilTypes } from "node:util";

const isProxy = nodeUtilTypes.isProxy;
const isUint8Array = nodeUtilTypes.isUint8Array;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const objectPrototype = Object.prototype;
const numberIsSafeInteger = Number.isSafeInteger;
const arrayBufferPrototype = ArrayBuffer.prototype;
const uint8ArrayConstructor = Uint8Array;
const uint8ArrayPrototype = Uint8Array.prototype;
const typedArrayPrototype = objectGetPrototypeOf(uint8ArrayPrototype);
const typedArrayBufferGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffsetGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const typedArrayLengthGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, "length")?.get;
const arrayBufferByteLengthGetter = objectGetOwnPropertyDescriptor(arrayBufferPrototype, "byteLength")?.get;
const arrayBufferDetachedGetter = objectGetOwnPropertyDescriptor(arrayBufferPrototype, "detached")?.get;
const uint8ArrayAt = uint8ArrayPrototype.at;
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
  const descriptor = objectGetOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Read a data property without invoking accessors, including class methods. */
export function dataPropertyValueV1(value: unknown, key: PropertyKey): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  let current: object | null = value;
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (isHostProxyV1(current)) return undefined;
    const descriptor = objectGetOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = objectGetPrototypeOf(current) as object | null;
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
  if (!value || typeof value !== "object" || isHostProxyV1(value) || arrayIsArray(value)) return undefined;
  const prototype = objectGetPrototypeOf(value);
  if (prototype !== objectPrototype && !(options.allowNullPrototype && prototype === null)) return undefined;
  for (let left = 0; left < requiredKeys.length; left += 1) {
    for (let right = left + 1; right < requiredKeys.length; right += 1) {
      if (requiredKeys[left] === requiredKeys[right]) return undefined;
    }
    for (let right = 0; right < optionalKeys.length; right += 1) {
      if (requiredKeys[left] === optionalKeys[right]) return undefined;
    }
  }
  for (let left = 0; left < optionalKeys.length; left += 1) {
    for (let right = left + 1; right < optionalKeys.length; right += 1) {
      if (optionalKeys[left] === optionalKeys[right]) return undefined;
    }
  }
  const ownKeys = reflectOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string") return undefined;
    let allowed = false;
    for (let requiredIndex = 0; requiredIndex < requiredKeys.length; requiredIndex += 1) {
      if (key === requiredKeys[requiredIndex]) { allowed = true; break; }
    }
    if (!allowed) {
      for (let optionalIndex = 0; optionalIndex < optionalKeys.length; optionalIndex += 1) {
        if (key === optionalKeys[optionalIndex]) { allowed = true; break; }
      }
    }
    if (!allowed) return undefined;
  }
  for (let requiredIndex = 0; requiredIndex < requiredKeys.length; requiredIndex += 1) {
    let present = false;
    for (let ownIndex = 0; ownIndex < ownKeys.length; ownIndex += 1) {
      if (requiredKeys[requiredIndex] === ownKeys[ownIndex]) { present = true; break; }
    }
    if (!present) return undefined;
  }
  const descriptors = objectGetOwnPropertyDescriptors(value), snapshot: Record<string, unknown> = {};
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index] as string;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) return undefined;
    objectDefineProperty(snapshot, key, {
      value: descriptor.value, enumerable: true, configurable: true, writable: true,
    });
  }
  return snapshot;
}

/** Snapshot an exact dense ordinary array without iteration or property reads. */
export function exactHostDataArrayV1(value: unknown, maximum: number): unknown[] | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !arrayIsArray(value)) return undefined;
  if (objectGetPrototypeOf(value) !== arrayPrototype) return undefined;
  const lengthDescriptor = objectGetOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !numberIsSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) return undefined;
  const length = lengthDescriptor.value as number, ownKeys = reflectOwnKeys(value);
  if (ownKeys.length !== length + 1) return undefined;
  for (let index = 0; index < length; index += 1) if (ownKeys[index] !== `${index}`) return undefined;
  if (ownKeys[length] !== "length") return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = objectGetOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) return undefined;
    objectDefineProperty(result, `${index}`, {
      value: descriptor.value, enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

export interface ExactHostUint8ArrayV1 {
  readonly byteLength: number;
  byteAt(index: number): number | undefined;
  copy(length?: number): Uint8Array;
  wipe(): void;
}

/** Read byte length through captured host operations without property lookup. */
export function hostUint8ArrayByteLengthV1(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !isUint8Array(value)) return undefined;
  try {
    const byteLength = reflectApply(typedArrayByteLengthGetter!, value, []) as number;
    return numberIsSafeInteger(byteLength) && byteLength >= 0 ? byteLength : undefined;
  } catch { return undefined; }
}

function wipeArrayBufferV1(buffer: ArrayBufferLike): boolean {
  try {
    const wholeBuffer = new uint8ArrayConstructor(buffer);
    const byteLength = reflectApply(typedArrayByteLengthGetter!, wholeBuffer, []) as number;
    if (!numberIsSafeInteger(byteLength) || byteLength < 0) return false;
    for (let index = 0; index < byteLength; index += 1) wholeBuffer[index] = 0;
    for (let index = 0; index < byteLength; index += 1) {
      if (reflectApply(uint8ArrayAt, wholeBuffer, [index]) !== 0) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * Observe an exact Uint8Array through captured native intrinsics only. This
 * rejects shared/detached or partial backing stores, subclasses, prototype
 * drift, and any own property that could shadow metadata without executing it.
 */
export function exactHostUint8ArrayV1(value: unknown, maximum: number): ExactHostUint8ArrayV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value)
    || !numberIsSafeInteger(maximum) || maximum < 0) return undefined;
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
      || !numberIsSafeInteger(byteLength) || byteLength < 0 || byteLength > maximum
      || byteOffset !== 0 || byteLength !== bufferByteLength) return undefined;
    const keys = reflectOwnKeys(value);
    if (keys.length !== length) return undefined;
    for (let index = 0; index < keys.length; index += 1) if (keys[index] !== `${index}`) return undefined;
    const typedValue = value as Uint8Array;
    return objectFreeze({
      byteLength,
      byteAt(index: number) {
        if (!numberIsSafeInteger(index) || index < 0 || index >= byteLength) return undefined;
        return reflectApply(uint8ArrayAt, typedValue, [index]) as number;
      },
      copy(copyLength: number = byteLength) {
        if (!numberIsSafeInteger(copyLength) || copyLength < 0 || copyLength > byteLength) throw new Error("binary copy length invalid");
        const source = new uint8ArrayConstructor(buffer, byteOffset, copyLength), copy = new uint8ArrayConstructor(copyLength);
        reflectApply(uint8ArraySet, copy, [source]);
        return copy;
      },
      wipe() {
        if (!wipeArrayBufferV1(buffer)) throw new Error("binary wipe failed");
      },
    });
  } catch { return undefined; }
}

/** Wipe an actual Uint8Array through its intrinsic, even when its shape is invalid. */
export function wipeHostUint8ArrayV1(value: unknown): boolean {
  if (!value || typeof value !== "object" || isHostProxyV1(value)) return false;
  try {
    const buffer = reflectApply(typedArrayBufferGetter!, value, []) as ArrayBufferLike;
    return wipeArrayBufferV1(buffer);
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
  const collector = objectFreeze({ submit(value: unknown) {
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
