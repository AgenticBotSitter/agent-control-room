import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { jobStates, effectIntentStates } from "../../domain/v1/types";

export const newsCollectionStatusSchema = z.object({
  projectId: id, sourceId: id, configured: z.boolean(), observedAt: z.string().datetime(),
  latest: z.object({ jobId: id, jobState: z.enum(jobStates), effectState: z.enum(effectIntentStates).nullable(),
    updatedAt: z.string().datetime(), state: z.enum(["prepared", "queued", "running", "completed", "failed", "cancelled", "uncertain"]),
  }).strict().nullable(),
}).strict().refine(value => value.configured || value.latest === null)
  .refine(value => !value.latest || value.latest.state === newsCollectionState(value.latest.jobState, value.latest.effectState));
export type NewsCollectionStatus = z.infer<typeof newsCollectionStatusSchema>;

/** Both durable records must agree before displaying completion. Missing or
 * incompatible settlement is uncertainty, not permission to run again. */
export function newsCollectionState(job: typeof jobStates[number], effect: typeof effectIntentStates[number] | null): "prepared" | "queued" | "running" | "completed" | "failed" | "cancelled" | "uncertain" {
  if (job === "proposed" && effect === null) return "prepared";
  if (job === "succeeded" && effect === "confirmed") return "completed";
  if (job === "failed" && effect === "failed") return "failed";
  if (job === "cancelled" && effect === "cancelled") return "cancelled";
  if (job === "running" && effect === "executing") return "running";
  if (["ready", "leased"].includes(job) && effect === "authorized") return "queued";
  return "uncertain";
}
