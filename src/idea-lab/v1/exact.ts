import { assertSafeProjection } from "../../contracts/v1";
import { assertNoSecretMaterial } from "../../security";
import { exactHostDataArrayV1, isHostProxyV1 } from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";

const nativeArrayIsArrayV1 = Array.isArray, nativeErrorV1 = Error;
const nativeNumberIsFiniteV1 = Number.isFinite, nativeObjectDefinePropertyV1 = Object.defineProperty,
  nativeObjectGetOwnPropertyDescriptorsV1 = Object.getOwnPropertyDescriptors,
  nativeObjectGetPrototypeOfV1 = Object.getPrototypeOf, nativeObjectPrototypeV1 = Object.prototype,
  nativeReflectApplyV1 = Reflect.apply, nativeReflectOwnKeysV1 = Reflect.ownKeys,
  nativeRegExpExecV1 = RegExp.prototype.exec;
const redactionErrorPatternV1 = /secret|unsafe|forbidden/i;

function snapshot(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new IdeaLabErrorV1("invalid_input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && nativeNumberIsFiniteV1(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) throw new IdeaLabErrorV1("invalid_input");
  if (nativeArrayIsArrayV1(value)) {
    const items = exactHostDataArrayV1(value, 100);
    if (!items) throw new IdeaLabErrorV1("invalid_input");
    const projected: unknown[] = [];
    for (let index = 0; index < items.length; index += 1) projected[index] = snapshot(items[index], depth + 1);
    return projected;
  }
  if (nativeObjectGetPrototypeOfV1(value) !== nativeObjectPrototypeV1) throw new IdeaLabErrorV1("invalid_input");
  const keys = nativeReflectOwnKeysV1(value), descriptors = nativeObjectGetOwnPropertyDescriptorsV1(value),
    result: Record<string, unknown> = {};
  if (keys.length > 100) throw new IdeaLabErrorV1("invalid_input");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") throw new IdeaLabErrorV1("invalid_input");
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable
      || descriptor.value === undefined) throw new IdeaLabErrorV1("invalid_input");
    nativeObjectDefinePropertyV1(result, key, { value: snapshot(descriptor.value, depth + 1), enumerable: true });
  }
  return result;
}

export function parseExactIdeaLabV1<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(snapshot(value));
    assertNoSecretMaterial(parsed, "idea lab"); assertSafeProjection(parsed); return parsed;
  } catch (error) {
    if (error instanceof IdeaLabErrorV1) throw error;
    if (error instanceof nativeErrorV1
      && nativeReflectApplyV1(nativeRegExpExecV1, redactionErrorPatternV1, [error.message]) !== null) {
      throw new IdeaLabErrorV1("redaction_rejected");
    }
    throw new IdeaLabErrorV1("invalid_input");
  }
}
