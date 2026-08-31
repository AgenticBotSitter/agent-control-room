import { assertSafeProjection } from "../../contracts/v1";
import { assertNoSecretMaterial } from "../../security";
import { exactHostDataArrayV1, isHostProxyV1 } from "../../security/host-value";
import { ProjectWorkspaceContractErrorV1 } from "./errors";

interface BudgetV1 { remaining: number; }

function snapshot(value: unknown, budget: BudgetV1, depth: number): unknown {
  if (depth > 24 || budget.remaining-- <= 0) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  if (Array.isArray(value)) {
    const items = exactHostDataArrayV1(value, 10_000);
    if (!items) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    return items.map((item) => snapshot(item, budget, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 500 || keys.some((key) => typeof key !== "string")) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable || descriptor.value === undefined) {
      throw new ProjectWorkspaceContractErrorV1("invalid_input");
    }
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, budget, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function exactProjectWorkspaceJsonV1(value: unknown): unknown {
  return snapshot(value, { remaining: 75_000 }, 0);
}

export function parseExactProjectWorkspaceV1<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  let parsed: T;
  try {
    parsed = schema.parse(exactProjectWorkspaceJsonV1(value));
  } catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  try {
    assertNoSecretMaterial(parsed, "project workspace projection");
    assertSafeProjection(parsed);
  } catch {
    throw new ProjectWorkspaceContractErrorV1("redaction_rejected");
  }
  return parsed;
}
