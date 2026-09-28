import { z } from "zod";
import { catalogProjectIdSchema } from "./project-wire";

const id = catalogProjectIdSchema;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/);

export const SESSION_WATCH_EXPECTED_HEARTBEAT_MS_V1 = 120_000;
export const SESSION_WATCH_PAGE_SIZE_V1 = 25;

export const sessionWatchItemSchemaV1 = z.object({
  sessionId: id,
  runId: id.nullable(),
  projectId: id,
  jobId: id,
  taskTitle: z.string().trim().min(1).max(180),
  attemptId: id,
  attemptNumber: count,
  worker: z.string().trim().min(1).max(200).nullable(),
  harness: z.enum(["hermes", "codex", "claude", "other"]).nullable(),
  model: model.nullable(),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).nullable(),
  stage: z.string().trim().min(1).max(80),
  state: z.enum(["running", "waiting_for_review", "blocked", "stalled"]),
  durationSeconds: count,
  lastProgressAt: z.string().datetime(),
  lastProgress: z.string().trim().min(1).max(120),
  expectedHeartbeatSeconds: z.literal(120),
}).strict();

export const sessionWatchPageSchemaV1 = z.object({
  source: z.enum(["configured", "not_configured"]),
  sessions: z.array(sessionWatchItemSchemaV1).max(SESSION_WATCH_PAGE_SIZE_V1),
  nextCursor: id.nullable(),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.source === "not_configured" && (value.sessions.length || value.nextCursor)) {
    context.addIssue({ code: "custom", message: "unconfigured session watch cannot report sessions" });
  }
  if (new Set(value.sessions.map(session => session.sessionId)).size !== value.sessions.length) {
    context.addIssue({ code: "custom", message: "session ids must be unique" });
  }
});

export type SessionWatchItemV1 = z.infer<typeof sessionWatchItemSchemaV1>;
export type SessionWatchPageV1 = z.infer<typeof sessionWatchPageSchemaV1>;
