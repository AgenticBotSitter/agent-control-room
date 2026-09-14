import {
  processRetirementProofDigestV1,
  processRetirementProofSchemaV1,
  type ProcessRetirementProofV1,
} from "../../contracts/v1/project-coordination-boundaries";
import { isHostProxyV1 } from "../../security/host-value";
import { ProjectCoordinationErrorV1, failProjectCoordinationV1 } from "./errors";

/**
 * The only path that releases a resource holder.
 *
 * Lease expiry, disconnect, browser closure, arbitrary result text and a bare
 * transport receipt are all explicitly not evidence. Release requires the exact
 * authenticated process-retirement proof defined by the shared contract module,
 * checked by a verifier captured in the server/node composition rather than
 * supplied with the request. The database's reserved `trusted_no_start` value has
 * no proof contract yet, so this package never produces it.
 */

export interface ProcessRetirementVerifierPortV1 {
  /**
   * Confirms the proof against the captured authenticated source (native
   * recovery or the owned Codex process). It returns false for anything it
   * cannot authenticate; it never repairs or completes a proof.
   */
  verifyProcessRetirement(proof: ProcessRetirementProofV1): Promise<boolean> | boolean;
}

export interface ProcessRetirementAuthorizationV1 {
  readonly proof: ProcessRetirementProofV1;
  readonly proofDigest: string;
}

const authorizations = new WeakSet<object>();

/** Verifies retirement evidence and mints the single-use authorization the canonical store demands. */
export async function authorizeProcessRetirementV1(
  verifier: ProcessRetirementVerifierPortV1,
  value: unknown,
): Promise<ProcessRetirementAuthorizationV1> {
  if (!verifier || typeof verifier !== "object" || isHostProxyV1(verifier)
    || typeof verifier.verifyProcessRetirement !== "function") {
    return failProjectCoordinationV1("retirement_evidence_unauthorized");
  }
  const parsed = processRetirementProofSchemaV1.safeParse(value);
  if (!parsed.success) return failProjectCoordinationV1("retirement_evidence_invalid");
  let authentic = false;
  try {
    authentic = await verifier.verifyProcessRetirement(parsed.data) === true;
  } catch (error) {
    if (error instanceof ProjectCoordinationErrorV1) throw error;
    authentic = false;
  }
  if (!authentic) return failProjectCoordinationV1("retirement_evidence_unauthorized");
  const authorization = Object.freeze({
    proof: Object.freeze(parsed.data),
    proofDigest: processRetirementProofDigestV1(parsed.data),
  });
  authorizations.add(authorization);
  return authorization;
}

/** Recognises only an authorization this module minted from verified evidence. */
export function acquireProcessRetirementAuthorizationV1(value: unknown): ProcessRetirementAuthorizationV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !authorizations.has(value)
    || !Object.isFrozen(value)) return undefined;
  return value as ProcessRetirementAuthorizationV1;
}

/**
 * The reserved no-start state has no proof contract in this package. Callers that
 * believe a process never started must still produce process-retirement evidence;
 * absent it, the holder stays held.
 */
export function refuseNoStartReleaseV1(): never {
  return failProjectCoordinationV1("no_start_release_unsupported");
}
