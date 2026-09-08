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

/** A page of verified matches, not a claim to contain the latest source run.
 * Cursor follows project plan IDs because source identity is verified after read. */
export const newsCollectionHistorySchema = z.object({
  projectId: id, sourceId: id, configured: z.boolean(), observedAt: z.string().datetime(),
  after: id.nullable(), nextCursor: id.nullable(), scanned: z.number().int().min(0).max(25),
  entries: z.array(z.object({ jobId: id, createdAt: z.string().datetime() }).strict()).max(25),
}).strict().refine(value => {
  if (!value.configured && (value.scanned || value.entries.length || value.nextCursor !== null)) return false;
  if (value.entries.length > value.scanned || value.nextCursor !== null && value.scanned !== 25) return false;
  if (value.nextCursor !== null && value.after !== null && value.nextCursor <= value.after) return false;
  return value.entries.every((entry, i) => (value.after === null || entry.jobId > value.after)
    && (i === 0 || entry.jobId > value.entries[i - 1].jobId)
    && (value.nextCursor === null || entry.jobId <= value.nextCursor));
});
export type NewsCollectionHistory = z.infer<typeof newsCollectionHistorySchema>;

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
