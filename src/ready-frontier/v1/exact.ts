import { assertSafeProjection } from "../../contracts/v1";
import { assertNoSecretMaterial } from "../../security";
import { exactHostDataArrayV1, isHostProxyV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";

interface BudgetV1 { remaining: number; }

const objectPrototypeV1 = Object.prototype;
const objectGetPrototypeOfV1 = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const objectDefinePropertyV1 = Object.defineProperty;
const reflectOwnKeysV1 = Reflect.ownKeys;
const arrayIsArrayV1 = Array.isArray;
const numberIsFiniteV1 = Number.isFinite;

function snapshot(value: unknown, budget: BudgetV1, depth: number): unknown {
  if (depth > 24 || budget.remaining-- <= 0) throw new ReadyFrontierContractErrorV1("invalid_input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && numberIsFiniteV1(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) throw new ReadyFrontierContractErrorV1("invalid_input");
  if (arrayIsArrayV1(value)) {
    const items = exactHostDataArrayV1(value, 20_000);
    if (!items) throw new ReadyFrontierContractErrorV1("invalid_input");
    const result: unknown[] = [];
    for (let index = 0; index < items.length; index += 1) {
      objectDefinePropertyV1(result, `${index}`, {
        value: snapshot(items[index], budget, depth + 1), enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  }
  if (objectGetPrototypeOfV1(value) !== objectPrototypeV1) throw new ReadyFrontierContractErrorV1("invalid_input");
  const keys = reflectOwnKeysV1(value);
  if (keys.length > 500) throw new ReadyFrontierContractErrorV1("invalid_input");
  const result: Record<string, unknown> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") throw new ReadyFrontierContractErrorV1("invalid_input");
    const descriptor = objectGetOwnPropertyDescriptorV1(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable || descriptor.value === undefined) {
      throw new ReadyFrontierContractErrorV1("invalid_input");
    }
    objectDefinePropertyV1(result, key, {
      value: snapshot(descriptor.value, budget, depth + 1), enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

export function exactReadyFrontierJsonV1(value: unknown): unknown {
  return snapshot(value, { remaining: 100_000 }, 0);
}

export function parseExactReadyFrontierV1<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  let parsed: T;
  try { parsed = schema.parse(exactReadyFrontierJsonV1(value)); }
  catch (error) {
    if (error instanceof ReadyFrontierContractErrorV1) throw error;
    throw new ReadyFrontierContractErrorV1("invalid_input");
  }
  try { assertNoSecretMaterial(parsed, "ready frontier projection"); assertSafeProjection(parsed); }
  catch { throw new ReadyFrontierContractErrorV1("redaction_rejected"); }
  return parsed;
}
