import { z } from "zod";

/**
 * Durable, non-executing registration for one accepted remote delivery. It
 * contains only public fingerprints already retained by the controller; it
 * never contains a host, secret, prompt, result, or transport detail.
 */
const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const leaseEpoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const remoteTaskRegistrationSchemaV1 = z.object({
  workerId: id,
  adapterId: id,
  adapterRevision: z.string().min(7).max(180),
  deliveryDigest: digest,
  receiptDigest: digest,
  enrollmentDigest: digest,
  leaseId: id,
  leaseEpoch,
  inputDigest: digest,
  deadline: instant,
}).strict();

export type RemoteTaskRegistrationV1 = z.infer<typeof remoteTaskRegistrationSchemaV1>;
