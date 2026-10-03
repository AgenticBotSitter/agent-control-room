import { z } from "zod";
import { assertNoPortablePrototypePollutionV1 } from "./inert-portable-input";

/** Preserve future upstream fields without letting Zod copy prototype setters.
 * Refuse dangerous keys recursively BEFORE the passthrough object is constructed.
 * Depth is bounded so malformed replies cannot overflow the guard's stack.
 */
export function upstreamObjectV1<T extends z.ZodRawShape>(shape: T) {
  const schema = z.object(shape).passthrough();
  return z.preprocess((value: z.input<typeof schema>, context) => {
    try {
      assertNoPortablePrototypePollutionV1("upstream", value, 64);
      return value;
    } catch {
      context.addIssue({ code: "custom", message: "upstream_object_refused" });
      return z.NEVER;
    }
  }, schema);
}
