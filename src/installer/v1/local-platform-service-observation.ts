import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** One installation-wide health observation, independent of agent harness. */
const schema = z.object({
  state: z.enum(["running", "stopped", "failed", "uncertain", "revoked"]),
  topologyPlanDigest: digest, releaseDigest: digest, serviceIdentityDigest: digest,
  databaseAuthorityDigest: digest, protectedDataBindingDigest: digest,
  supervisorReadinessDigest: digest, observationDigest: digest,
}).strict();
const refuse = (): never => { throw new Error("local_platform_service_observation_refused"); };

export function captureLocalPlatformServiceObservationV1(value: unknown) {
  try { return Object.freeze(schema.parse(value)); }
  catch { return refuse(); }
}

/** Hashes a separately supplied observation; does not observe or start service.
 * Preserve the original v1 domain so existing platform_service outcomes remain
 * valid after extracting this installation-wide seam from the Hermes binding. */
export function localPlatformServiceObservationDigestV1(value: unknown): string {
  try { return sha256Digest({ purpose: "local-hermes-service-observation/v1",
    observation: captureLocalPlatformServiceObservationV1(value) }); }
  catch { return refuse(); }
}
