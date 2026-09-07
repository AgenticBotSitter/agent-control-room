import type { DatabaseClient } from "../../src/persistence/database.ts";
import { buildIdeaLabFixtureV1 } from "../../src/idea-lab/v1/fixture.ts";
import { buildIdeaLabSessionV1, buildIdeaLabContributionV1, buildIdeaLabSynthesisV1, buildIdeaLabDecisionV1 } from "../../src/idea-lab/v1/contracts.ts";
import { IdeaLabProjectRegistryStoreV1 } from "../../src/idea-lab/v1/store.ts";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../src/idea-lab/v1/schemas.ts";

// Test-only synthetic integrity material. Never used as runtime configuration.
export const webIdeaKey = new Uint8Array(32).fill(0x63);
const pick = (source: object, keys: string) => Object.fromEntries(keys.split(" ").map(key => [key, (source as Record<string, unknown>)[key]]));
export async function seedWebIdea(client: DatabaseClient, options: { workspaceId?: string; projectId?: string } = {}) {
  const source = buildIdeaLabFixtureV1();
  const projectId = options.projectId ?? "project.idea:web";
  const session = buildIdeaLabSessionV1({ ...pick(source.session,
    "title ideaSummary targetCustomer participants maxRounds maxDurationSeconds maxCostUsd createdByIdentityDigest createdAt"),
    tenantId: "tenant:web", workspaceId: options.workspaceId ?? "workspace:web", sessionId: `idea:${projectId}` });
  const contributions = source.contributions.map(item => buildIdeaLabContributionV1(session, pick(item,
    "participantId round safeOpinion opportunityCode primaryRiskCode suggestedExperiment confidencePercent contributedAt")));
  const synthesis = buildIdeaLabSynthesisV1(session, contributions, pick(source.synthesis,
    "marketDemand feasibility differentiation durability ownerFit riskPercent executiveSummary nextExperiment dissentingPerspectiveCodes synthesizedAt"));
  const decision = buildIdeaLabDecisionV1(session, synthesis, contributions, {
    ...pick(source.decision, "decision safeReasonCode ownerIdentityDigest decidedAt"), project: { ...source.decision.project!, projectId } });
  await client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,'tenant:web','control_room_native_ideas','1.0.0','control_room_native','fixture','v1',30) ON CONFLICT DO NOTHING`, [CONTROL_ROOM_IDEA_ADAPTER_V1]);
  const store = new IdeaLabProjectRegistryStoreV1(client, webIdeaKey);
  await store.registerSession(session);
  for (const contribution of contributions) await store.recordContribution(contribution);
  await store.recordSynthesis(synthesis);
  const { project } = await store.recordDecision(decision);
  return { project: project!, store, decision };
}
