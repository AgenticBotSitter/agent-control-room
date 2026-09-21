import { z } from "zod";
import { installationSetupStagesV1, verifyInstallationPlanV1 } from "./installation-plan";

export const INSTALLATION_PLAN_VIEW_V1 = "control-room.installation-plan-view/v1" as const;

const state = z.enum(["not_started", "running", "passed", "failed", "uncertain"]);
const stage = z.enum(installationSetupStagesV1);
const schema = z.object({
  schema: z.literal(INSTALLATION_PLAN_VIEW_V1),
  overallState: z.enum(["in_progress", "attention", "reviewed"]),
  stages: z.array(z.object({ stage, state }).strict()).length(installationSetupStagesV1.length),
  performsEffect: z.literal(false),
  exposesPrivateValues: z.literal(false),
}).strict();

type ParsedInstallationPlanViewV1 = z.infer<typeof schema>;
export type InstallationPlanViewV1 = Readonly<Omit<ParsedInstallationPlanViewV1, "stages"> & {
  stages: readonly Readonly<ParsedInstallationPlanViewV1["stages"][number]>[];
}>;

/** Browser-safe setup progress. Digests, revisions and raw evidence stay private. */
export function createInstallationPlanViewV1(value: unknown): InstallationPlanViewV1 {
  const plan = verifyInstallationPlanV1(value);
  const stages = plan.stages.map(item => Object.freeze({ stage: item.stage, state: item.state }));
  const overallState = stages.some(item => item.state === "failed" || item.state === "uncertain")
    ? "attention" as const
    : stages.every(item => item.state === "passed") ? "reviewed" as const : "in_progress" as const;
  return Object.freeze({ schema: INSTALLATION_PLAN_VIEW_V1, overallState,
    stages: Object.freeze(stages), performsEffect: false, exposesPrivateValues: false });
}

export function verifyInstallationPlanViewV1(value: unknown): InstallationPlanViewV1 {
  const parsed = schema.parse(value);
  if (parsed.stages.some((item, index) => item.stage !== installationSetupStagesV1[index])) {
    throw new Error("installation_plan_view_invalid");
  }
  const expectedOverall = parsed.stages.some(item => item.state === "failed" || item.state === "uncertain")
    ? "attention" : parsed.stages.every(item => item.state === "passed") ? "reviewed" : "in_progress";
  if (parsed.overallState !== expectedOverall) throw new Error("installation_plan_view_invalid");
  return Object.freeze({ ...parsed, stages: Object.freeze(parsed.stages.map(item => Object.freeze({ ...item }))) });
}
