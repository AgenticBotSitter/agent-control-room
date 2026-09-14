import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";

/**
 * A separate namespace is deliberately part of every v2 digest input.  A
 * sha256 value has no visible namespace of its own, so accepting a bare
 * digest is never sufficient to make a v1 value a v2 value.
 */
export const RESOURCE_BOUND_WIRE_V2_NAMESPACE = "control-room.resource-bound-wire/v2" as const;
export const RESOURCE_ADMISSION_BINDING_SCHEMA_V2 = "control-room.resource-admission-binding/v2" as const;

/** These are stable canonical record IDs, deliberately not a versioned replacement identity scheme. */
export const resourceBoundWireV2IdSchema = localId;
export const resourceBoundWireV2DigestSchema = digestSchema;

export const resourceAdmissionBindingSchemaV2 = z.object({
  resourceAdmissionId: resourceBoundWireV2IdSchema,
  resourceAdmissionDigest: resourceBoundWireV2DigestSchema,
}).strict();

export type ResourceAdmissionBindingV2 = z.infer<typeof resourceAdmissionBindingSchemaV2>;

/** Parse exactly the two admission values that must cross every v2 boundary. */
export function parseResourceAdmissionBindingV2(value: unknown): Readonly<ResourceAdmissionBindingV2> {
  return Object.freeze(resourceAdmissionBindingSchemaV2.parse(value));
}

function requireV2Namespace(namespace: string): string {
  if (!namespace.endsWith("/v2")) throw new Error("resource_bound_wire_v2_namespace_required");
  return namespace;
}

/** Domain-separated digest helper. Never use this for an unqualified v1 material object. */
export function resourceBoundWireV2Digest(namespace: string, value: unknown): string {
  return sha256Digest({ namespace: requireV2Namespace(namespace), value });
}

/** Deterministic IDs retain the existing local-ID form; their digest preimage is /v2-separated. */
export function resourceBoundWireV2Id(kind: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(kind)) throw new Error("resource_bound_wire_v2_id_kind_invalid");
  return `${kind}:${resourceBoundWireV2Digest(`${RESOURCE_BOUND_WIRE_V2_NAMESPACE}/${kind}/v2`, value).slice(7)}`;
}
