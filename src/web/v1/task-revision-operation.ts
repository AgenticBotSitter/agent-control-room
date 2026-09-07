import type { TaskExecutionPlanner } from "./task-execution-planner";

/** Scoped, non-executing operation owned by the separately restricted coordinator. */
export type TaskRevisionOperation = { tenantId: string; workspaceId: string; plan: TaskExecutionPlanner["revise"] };
