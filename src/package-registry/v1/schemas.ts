import { z } from "zod";
import { harnessAdapterManifestSchemaV1 } from "../../harness/v1";
import { PACKAGE_REGISTRY_SCHEMA_VERSION_V1 } from "./types";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const label = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:+ -]*$/);
const version = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });
const text = z.string().min(1).max(4_000);
const unique = <T extends z.ZodTypeAny>(schema: T, maximum: number) => z.array(schema).min(1).max(maximum).superRefine((values, context) => {
  if (new Set(values.map((value) => JSON.stringify(value))).size !== values.length) context.addIssue({ code: "custom", message: "values must be unique" });
});

const compatibility = z.object({
  adapterId: id, adapterVersion: version, harness: z.enum(["hermes", "codex", "claude", "other"]), harnessVersion: version,
  requiredVerbs: unique(z.enum(["discover", "start", "stream", "steer", "cancel", "resume", "usage"]), 7),
  supportedPlatforms: unique(z.enum(["linux", "macos", "windows"]), 3),
}).strict();

const provenance = z.object({
  sourceType: z.enum(["owner", "repository", "reviewed_agent", "imported", "run_outcome"]),
  sourceId: id, sourceDigest: digest, producerId: id, producedAt: time,
}).strict();

const separation = z.object({ grantsAuthority: z.literal(false), suppliesPolicy: z.literal(false), containsCredentials: z.literal(false) }).strict();
const packageBase = {
  schemaVersion: z.literal(PACKAGE_REGISTRY_SCHEMA_VERSION_V1), id, tenantId: id, projectId: id,
  name: label, version, provenance, compatibility: unique(compatibility, 12), separation, createdAt: time,
};

const procedureContent = z.object({
  objective: text,
  steps: unique(z.object({ id, instruction: text }).strict(), 100),
  acceptanceSteps: unique(z.object({ id, check: text }).strict(), 50),
  inputRoles: z.array(label).max(30), outputRoles: z.array(label).min(1).max(30),
}).strict().superRefine((content, context) => {
  if (new Set(content.steps.map((step) => step.id)).size !== content.steps.length) context.addIssue({ code: "custom", message: "step ids must be unique", path: ["steps"] });
  if (new Set(content.acceptanceSteps.map((step) => step.id)).size !== content.acceptanceSteps.length) context.addIssue({ code: "custom", message: "acceptance step ids must be unique", path: ["acceptanceSteps"] });
});

const knowledgeContent = z.object({
  facts: unique(z.object({ id, subject: text, predicate: text, value: text, evidenceDigest: digest, observedAt: time.optional(), validUntil: time.optional() }).strict(), 500),
  references: z.array(z.object({ id, kind: z.enum(["artifact", "document", "repository", "external_reference"]), locatorDigest: digest, contentDigest: digest }).strict()).max(200),
}).strict().superRefine((content, context) => {
  if (new Set(content.facts.map((fact) => fact.id)).size !== content.facts.length) context.addIssue({ code: "custom", message: "fact ids must be unique", path: ["facts"] });
  if (new Set(content.references.map((reference) => reference.id)).size !== content.references.length) context.addIssue({ code: "custom", message: "reference ids must be unique", path: ["references"] });
  for (const [index, fact] of content.facts.entries()) if (fact.observedAt && fact.validUntil && Date.parse(fact.validUntil) < Date.parse(fact.observedAt)) context.addIssue({ code: "custom", message: "fact validity cannot precede observation", path: ["facts", index, "validUntil"] });
});

export const registryPackageSchemaV1 = z.discriminatedUnion("kind", [
  z.object({ ...packageBase, kind: z.literal("procedure"), content: procedureContent }).strict(),
  z.object({ ...packageBase, kind: z.literal("knowledge"), content: knowledgeContent }).strict(),
]).superRefine((item, context) => {
  if (Date.parse(item.createdAt) < Date.parse(item.provenance.producedAt)) context.addIssue({ code: "custom", message: "creation cannot precede production", path: ["createdAt"] });
});

export const packageReviewSchemaV1 = z.object({
  schemaVersion: z.literal(PACKAGE_REGISTRY_SCHEMA_VERSION_V1), id, tenantId: id, projectId: id, packageId: id, packageDigest: digest,
  producerId: id, reviewerId: id, decision: z.enum(["accepted", "rejected"]), reasonCode: id,
  evidenceDigests: unique(digest, 50), reviewedAt: time,
}).strict().superRefine((review, context) => {
  if (review.producerId === review.reviewerId) context.addIssue({ code: "custom", message: "reviewer must be independent of producer", path: ["reviewerId"] });
});

export const packageHarnessMappingInputSchemaV1 = z.object({
  schemaVersion: z.literal(PACKAGE_REGISTRY_SCHEMA_VERSION_V1), id, tenantId: id, projectId: id, packageId: id, packageDigest: digest,
  adapterId: id, adapterVersion: version, harness: z.enum(["hermes", "codex", "claude", "other"]), harnessVersion: version,
  platform: z.enum(["linux", "macos", "windows"]), verifiedVerbs: unique(z.enum(["discover", "start", "stream", "steer", "cancel", "resume", "usage"]), 7),
  decision: z.enum(["verified", "rejected"]), verifierId: id, evidenceDigests: unique(digest, 50), verifiedAt: time,
}).strict();

export const packageHarnessMappingSchemaV1 = packageHarnessMappingInputSchemaV1.extend({
  manifestDigest:digest,manifest:harnessAdapterManifestSchemaV1,
}).strict();

export const packageActivationCommandSchemaV1 = z.object({
  schemaVersion: z.literal(PACKAGE_REGISTRY_SCHEMA_VERSION_V1), id, tenantId: id, projectId: id, packageId: id, packageDigest: digest,
  reviewId: id, mappingId: id, actorId: id, expectedActiveDigest: digest.nullable(), action: z.enum(["promote", "rollback"]), reasonCode: id, activatedAt: time,
}).strict();

export const packagePromotionSchemaV1 = packageActivationCommandSchemaV1.extend({
  packageKind:z.enum(["procedure","knowledge"]),packageName:label,priorPackageId: id.nullable(), priorPackageDigest: digest.nullable(), channelRevision: z.number().int().positive(), promotionDigest: digest,
}).strict();

export { digest as packageDigestSchemaV1 };
