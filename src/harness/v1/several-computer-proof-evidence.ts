import { z } from "zod";
import { isProxy } from "node:util/types";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { controllerWorkerAdapterIdSchemaV1 } from "./controller-worker-delivery";
import { createInstallationReadinessV1, verifyInstallationReadinessV1,
  type InstallationReadinessV1 } from "./installation-readiness";

export const SEVERAL_COMPUTER_ENROLLMENT_PROOF_REPORT_V1 =
  "control-room.several-computer-enrollment-proof-report/v1" as const;
export const SEVERAL_COMPUTER_DELIVERY_PROOF_REPORT_V1 =
  "control-room.several-computer-delivery-proof-report/v1" as const;
export const SEVERAL_COMPUTER_PROOF_EVIDENCE_V1 =
  "control-room.several-computer-proof-evidence/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const revision = z.string().min(7).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:+-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const planBinding = z.object({
  installationId: id,
  planDigest: digest,
  databaseAuthorityDigest: digest,
  schedulerAuthorityDigest: digest,
  currentRouteDigest: digest,
  requestedRouteDigest: digest,
  planMode: z.literal("several_computers"),
}).strict();

const workerBinding = z.object({
  intendedWorkerId: id,
  nonTargetWorkerIds: z.array(id).min(1).max(99),
  adapterId: controllerWorkerAdapterIdSchemaV1,
  adapterRevision: revision,
  enrollmentId: id,
  enrollmentDigest: digest,
  enrollmentWorkerId: id,
  certificateWorkerId: id,
  certificateDigest: digest,
  currentAuthorityDigest: digest,
}).strict();

const enrollmentFacts = z.object({
  enrollmentState: z.literal("enrolled"),
  enrollmentCurrent: z.literal(true),
  certificateIdentityMatched: z.literal(true),
  adapterRevisionCompatible: z.literal(true),
  protocolCompatible: z.literal(true),
  authorityCurrent: z.literal(true),
}).strict();

const deliveryFacts = z.object({
  dispatchCount: z.literal(1),
  receiptCount: z.literal(1),
  progressObservationCount: z.literal(2),
  progressPhases: z.tuple([z.literal("start"), z.literal("running")]),
  completedResultCount: z.literal(1),
  pendingReviewCount: z.literal(1),
  nonTargetDispatchCount: z.literal(0),
  disconnectOutcome: z.literal("uncertain"),
  disconnectRetryCount: z.literal(0),
  reconnectOutcome: z.literal("receipt_only_reconciled"),
  reconnectDispatchCount: z.literal(0),
  revokedWorkerOutcome: z.literal("refused_before_delivery"),
  revokedWorkerDispatchCount: z.literal(0),
  incompatibleWorkerOutcome: z.literal("refused_before_delivery"),
  incompatibleWorkerDispatchCount: z.literal(0),
  correctionRequestCount: z.literal(1),
  revisedResultCount: z.literal(1),
  revisedPendingReviewCount: z.literal(1),
}).strict();

export const severalComputerEnrollmentProofReportSchemaV1 = z.object({
  schema: z.literal(SEVERAL_COMPUTER_ENROLLMENT_PROOF_REPORT_V1),
  plan: planBinding,
  worker: workerBinding,
  facts: enrollmentFacts,
}).strict();

export const severalComputerDeliveryProofReportSchemaV1 = z.object({
  schema: z.literal(SEVERAL_COMPUTER_DELIVERY_PROOF_REPORT_V1),
  plan: planBinding,
  worker: workerBinding,
  facts: deliveryFacts,
}).strict();

/** Short aliases are exported for callers that do not use the UI proof name. */
export const severalComputerEnrollmentReportSchemaV1 = severalComputerEnrollmentProofReportSchemaV1;
export const severalComputerDeliveryReportSchemaV1 = severalComputerDeliveryProofReportSchemaV1;

export type SeveralComputerEnrollmentProofReportV1 = z.infer<typeof severalComputerEnrollmentProofReportSchemaV1>;
export type SeveralComputerDeliveryProofReportV1 = z.infer<typeof severalComputerDeliveryProofReportSchemaV1>;
export type SeveralComputerEnrollmentReportV1 = SeveralComputerEnrollmentProofReportV1;
export type SeveralComputerDeliveryReportV1 = SeveralComputerDeliveryProofReportV1;

const evidenceBase = z.object({
  schema: z.literal(SEVERAL_COMPUTER_PROOF_EVIDENCE_V1),
  proof: z.enum(["remote_enrollment", "two_computer_delivery"]),
  planDigest: digest,
  evidenceDigest: digest,
}).strict();

export type SeveralComputerEnrollmentEvidenceV1 = Readonly<{
  schema: typeof SEVERAL_COMPUTER_PROOF_EVIDENCE_V1;
  proof: "remote_enrollment";
  planDigest: string;
  report: SeveralComputerEnrollmentProofReportV1;
  evidenceDigest: string;
}>;

export type SeveralComputerDeliveryEvidenceV1 = Readonly<{
  schema: typeof SEVERAL_COMPUTER_PROOF_EVIDENCE_V1;
  proof: "two_computer_delivery";
  planDigest: string;
  report: SeveralComputerDeliveryProofReportV1;
  evidenceDigest: string;
}>;

export type SeveralComputerProofEvidenceV1 = SeveralComputerEnrollmentEvidenceV1 | SeveralComputerDeliveryEvidenceV1;

function unavailable(): never { throw new Error("several_computer_proof_evidence_unavailable"); }

/**
 * Validates passive caller data before reading it, then detaches it without
 * invoking accessors. Node's proxy check happens before any reflective
 * operation so a hostile proxy cannot run even an ownKeys trap.
 */
function inertClone(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : unavailable();
  if (typeof value !== "object" || isProxy(value)) return unavailable();
  if (seen.has(value)) return unavailable();
  seen.add(value);

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) unavailable();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key === "symbol")) unavailable();
  const output: unknown[] | Record<string, unknown> = array ? [] : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    if (!("value" in descriptor) || !descriptor.enumerable) unavailable();
    const cloned = inertClone(descriptor.value, seen);
    if (array) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) unavailable();
      output[Number(key)] = cloned;
    } else output[key] = cloned;
  }
  if (array && output.length !== value.length) unavailable();
  seen.delete(value);
  return output;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertBinding(report: SeveralComputerEnrollmentProofReportV1 | SeveralComputerDeliveryProofReportV1): void {
  const { intendedWorkerId, nonTargetWorkerIds, enrollmentWorkerId, certificateWorkerId } = report.worker;
  if (enrollmentWorkerId !== intendedWorkerId || certificateWorkerId !== intendedWorkerId
    || nonTargetWorkerIds.includes(intendedWorkerId)
    || new Set(nonTargetWorkerIds).size !== nonTargetWorkerIds.length
    || canonicalJson(nonTargetWorkerIds) !== canonicalJson([...nonTargetWorkerIds].sort())) unavailable();
}

function evidenceFor<P extends "remote_enrollment" | "two_computer_delivery",
  R extends SeveralComputerEnrollmentProofReportV1 | SeveralComputerDeliveryProofReportV1>(proof: P, report: R) {
  const material = { schema: SEVERAL_COMPUTER_PROOF_EVIDENCE_V1, proof, planDigest: report.plan.planDigest, report };
  return deepFreeze({ ...material, evidenceDigest: sha256Digest(material) });
}

/** Derives enrollment evidence only from a complete, sanitized report. */
export function deriveSeveralComputerEnrollmentEvidenceV1(reportValue: unknown): SeveralComputerEnrollmentEvidenceV1 {
  const report = severalComputerEnrollmentProofReportSchemaV1.parse(inertClone(reportValue));
  assertBinding(report);
  return evidenceFor("remote_enrollment", report);
}

/** Derives delivery-journey evidence independently from enrollment evidence. */
export function deriveSeveralComputerDeliveryEvidenceV1(reportValue: unknown): SeveralComputerDeliveryEvidenceV1 {
  const report = severalComputerDeliveryProofReportSchemaV1.parse(inertClone(reportValue));
  assertBinding(report);
  return evidenceFor("two_computer_delivery", report);
}

function verifiedEvidence(value: unknown): SeveralComputerProofEvidenceV1 {
  const cloned = inertClone(value);
  const selected = z.object({ proof: z.enum(["remote_enrollment", "two_computer_delivery"]) }).passthrough().parse(cloned);
  const reportSchema = selected.proof === "remote_enrollment"
    ? severalComputerEnrollmentProofReportSchemaV1 : severalComputerDeliveryProofReportSchemaV1;
  const parsed = evidenceBase.extend({ proof: z.literal(selected.proof), report: reportSchema }).strict().parse(cloned);
  const expected = selected.proof === "remote_enrollment"
    ? deriveSeveralComputerEnrollmentEvidenceV1(parsed.report)
    : deriveSeveralComputerDeliveryEvidenceV1(parsed.report);
  if (canonicalJson(parsed) !== canonicalJson(expected)) unavailable();
  return expected;
}

/**
 * Adds exactly the independently derived proof supplied by the caller. It
 * cannot manufacture the companion proof, replace unrelated readiness, or
 * accept an arbitrary caller-provided evidence digest.
 */
export function recordSeveralComputerProofReadinessV1(existingValue: unknown,
  evidenceValue: unknown): InstallationReadinessV1 {
  try {
    const evidence = verifiedEvidence(evidenceValue);
    const existing = existingValue === undefined ? undefined : verifyInstallationReadinessV1(inertClone(existingValue));
    if (existing && existing.planDigest !== evidence.planDigest) unavailable();
    const byProof = new Map(existing?.proofs.map(item => [item.proof, item]) ?? []);
    byProof.set(evidence.proof, { proof: evidence.proof, state: "passed", evidenceDigest: evidence.evidenceDigest });
    return createInstallationReadinessV1({ planDigest: evidence.planDigest, proofs: [...byProof.values()] });
  } catch { return unavailable(); }
}
