import { z } from "zod";

const nodes = z.number().int().min(0).max(32);
export const queueAttentionSchema = z.object({
  source: z.literal("current_process_recovery"),
  configuredNodes: nodes, unavailableNodes: nodes, notAttemptedNodes: nodes,
  runningNodes: nodes, completeNodes: nodes, uncertainNodes: nodes,
  held: z.number().int().min(0).max(1024), truncatedNodes: nodes,
  startsWork: z.literal(false),
}).strict().refine(value => value.unavailableNodes + value.notAttemptedNodes + value.runningNodes
  + value.completeNodes + value.uncertainNodes === value.configuredNodes
  && value.truncatedNodes <= value.completeNodes && value.held <= value.completeNodes * 32);
export type QueueAttention = z.infer<typeof queueAttentionSchema>;
export type QueueAttentionSource = { tenantId: string; workspaceId: string; read(): QueueAttention };
