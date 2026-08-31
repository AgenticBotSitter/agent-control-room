import { assertSafeProjection } from "../../contracts/v1";
import { assertNoSecretMaterial } from "../../security";
import { exactHostDataArrayV1, isHostProxyV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";

interface BudgetV1 { remaining: number; }

function snapshot(value: unknown, budget: BudgetV1, depth: number): unknown {
  if (depth > 24 || budget.remaining-- <= 0) throw new ReadyFrontierContractErrorV1("invalid_input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) throw new ReadyFrontierContractErrorV1("invalid_input");
  if (Array.isArray(value)) {
    const items = exactHostDataArrayV1(value, 20_000);
    if (!items) throw new ReadyFrontierContractErrorV1("invalid_input");
    return items.map((item) => snapshot(item, budget, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new ReadyFrontierContractErrorV1("invalid_input");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 500 || keys.some((key) => typeof key !== "string")) throw new ReadyFrontierContractErrorV1("invalid_input");
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable || descriptor.value === undefined) {
      throw new ReadyFrontierContractErrorV1("invalid_input");
    }
    Object.defineProperty(result, key, {
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
