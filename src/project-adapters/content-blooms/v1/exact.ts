import { assertSafeProjection } from "../../../contracts/v1";
import { assertNoSecretMaterial } from "../../../security";
import { exactHostDataArrayV1, isHostProxyV1 } from "../../../security/host-value";
import { ContentBloomsContractErrorV1 } from "./errors";

interface SnapshotBudgetV1 { remaining: number; }

function snapshot(value: unknown, budget: SnapshotBudgetV1, depth: number): unknown {
  if (depth > 24 || budget.remaining-- <= 0) throw new ContentBloomsContractErrorV1("invalid_input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  if (Array.isArray(value)) {
    const items = exactHostDataArrayV1(value, 5_000);
    if (!items) throw new ContentBloomsContractErrorV1("invalid_input");
    return items.map((item) => snapshot(item, budget, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new ContentBloomsContractErrorV1("invalid_input");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 500 || keys.some((key) => typeof key !== "string")) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable
      || descriptor.value === undefined) throw new ContentBloomsContractErrorV1("invalid_input");
    Object.defineProperty(result, key, {
      value: snapshot(descriptor.value, budget, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function exactContentBloomsJsonV1(value: unknown): unknown {
  return snapshot(value, { remaining: 50_000 }, 0);
}

export function parseExactContentBloomsV1<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  let parsed: T;
  try {
    parsed = schema.parse(exactContentBloomsJsonV1(value));
  } catch (error) {
    if (error instanceof ContentBloomsContractErrorV1) throw error;
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  try {
    assertNoSecretMaterial(parsed, "Content Blooms adapter record");
    assertSafeProjection(parsed);
  } catch {
    throw new ContentBloomsContractErrorV1("redaction_rejected");
  }
  return parsed;
}
