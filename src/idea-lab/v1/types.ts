import { z } from "zod";
import {
  ideaContributionSchemaV1, ideaDecisionSchemaV1, ideaParticipantSchemaV1, ideaSessionSchemaV1,
  ideaSynthesisSchemaV1, projectCreationSpecSchemaV1, projectLifecycleEventSchemaV1, projectRegistryProjectionSchemaV1,
  ideaLabSessionProjectionSchemaV1,
} from "./schemas";

export type IdeaLabParticipantV1 = z.infer<typeof ideaParticipantSchemaV1>;
export type IdeaLabSessionV1 = z.infer<typeof ideaSessionSchemaV1>;
export type IdeaLabContributionV1 = z.infer<typeof ideaContributionSchemaV1>;
export type IdeaLabSynthesisV1 = z.infer<typeof ideaSynthesisSchemaV1>;
export type IdeaLabDecisionV1 = z.infer<typeof ideaDecisionSchemaV1>;
export type ProjectCreationSpecV1 = z.infer<typeof projectCreationSpecSchemaV1>;
export type ProjectLifecycleEventV1 = z.infer<typeof projectLifecycleEventSchemaV1>;
export type ProjectRegistryProjectionV1 = z.infer<typeof projectRegistryProjectionSchemaV1>;
export type IdeaLabSessionProjectionV1 = z.infer<typeof ideaLabSessionProjectionSchemaV1>;
