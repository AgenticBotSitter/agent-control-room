import { assertSafeProjection } from "../../contracts/v1";
import { assertNoSecretMaterial } from "../../security";
import { exactHostDataArrayV1, isHostProxyV1 } from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";

function snapshot(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new IdeaLabErrorV1("invalid_input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) throw new IdeaLabErrorV1("invalid_input");
  if (Array.isArray(value)) {
    const items = exactHostDataArrayV1(value, 100);
    if (!items) throw new IdeaLabErrorV1("invalid_input");
    return items.map((item) => snapshot(item, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new IdeaLabErrorV1("invalid_input");
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = {};
  if (keys.length > 100 || keys.some((key) => typeof key !== "string")) throw new IdeaLabErrorV1("invalid_input");
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable
      || descriptor.value === undefined) throw new IdeaLabErrorV1("invalid_input");
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, depth + 1), enumerable: true });
  }
  return result;
}

export function parseExactIdeaLabV1<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(snapshot(value));
    assertNoSecretMaterial(parsed, "idea lab"); assertSafeProjection(parsed); return parsed;
  } catch (error) {
    if (error instanceof IdeaLabErrorV1) throw error;
    if (error instanceof Error && /secret|unsafe|forbidden/i.test(error.message)) throw new IdeaLabErrorV1("redaction_rejected");
    throw new IdeaLabErrorV1("invalid_input");
  }
}
