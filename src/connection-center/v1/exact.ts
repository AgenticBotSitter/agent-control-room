import { exactHostDataArrayV1, isHostProxyV1 } from "../../security/host-value";

export class ConnectionCenterExactValueErrorV1 extends Error {}

const arrayIsArray = Array.isArray;
const numberIsFinite = Number.isFinite;
const objectDefineProperty = Object.defineProperty;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;

function snapshot(value: unknown, budget: { remaining: number }, depth: number): unknown {
  if (depth > 16 || budget.remaining-- <= 0) throw new ConnectionCenterExactValueErrorV1();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && numberIsFinite(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) {
    throw new ConnectionCenterExactValueErrorV1();
  }
  if (arrayIsArray(value)) {
    const items = exactHostDataArrayV1(value, 64);
    if (!items) throw new ConnectionCenterExactValueErrorV1();
    const result: unknown[] = [];
    for (let index = 0; index < items.length; index += 1) result[index] = snapshot(items[index], budget, depth + 1);
    return result;
  }
  if (objectGetPrototypeOf(value) !== objectPrototype) throw new ConnectionCenterExactValueErrorV1();
  const keys = reflectOwnKeys(value), descriptors = objectGetOwnPropertyDescriptors(value);
  if (keys.length > 64) throw new ConnectionCenterExactValueErrorV1();
  const result: Record<string, unknown> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") throw new ConnectionCenterExactValueErrorV1();
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set
      || !descriptor.enumerable || descriptor.value === undefined) throw new ConnectionCenterExactValueErrorV1();
    objectDefineProperty(result, key, { value: snapshot(descriptor.value, budget, depth + 1), enumerable: true });
  }
  return result;
}

export function exactConnectionCenterJsonV1(value: unknown): unknown {
  return snapshot(value, { remaining: 5_000 }, 0);
}
