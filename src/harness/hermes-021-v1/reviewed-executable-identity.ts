import { types } from "node:util";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from "./connector-profile";

export const HERMES_021_MACOS_REVIEWED_EXECUTABLE_IDENTITY_V1 =
  "control-room.hermes-021-macos-reviewed-executable-identity/v1" as const;

const schema = z.object({
  schema: z.literal(HERMES_021_MACOS_REVIEWED_EXECUTABLE_IDENTITY_V1),
  executableSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expectedVersion: z.literal(HERMES_021_VERSION_V1),
  sourceRevision: z.literal(HERMES_021_SOURCE_REVISION_V1),
}).strict();

export type Hermes021MacosReviewedExecutableIdentityV1 = Readonly<z.infer<typeof schema>>;

const unavailable = (): never => {
  const error = new Error("hermes_021_macos_reviewed_executable_identity_unavailable");
  error.stack = undefined;
  throw error;
};

/** Captures only path-independent reviewed release identity. */
export function captureHermes021MacosReviewedExecutableIdentityV1(value: unknown):
Hermes021MacosReviewedExecutableIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return unavailable();
  const names = ["schema", "executableSha256", "expectedVersion", "sourceRevision"] as const;
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name as typeof names[number]))) return unavailable();
  const captured: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return unavailable();
    captured[name] = descriptor.value;
  }
  return Object.freeze(schema.parse(captured));
}

export function hermes021MacosReviewedExecutableIdentityDigestV1(value: unknown): string {
  return sha256Digest({ purpose: "hermes-021-reviewed-executable-identity/v1",
    identity: captureHermes021MacosReviewedExecutableIdentityV1(value) });
}
