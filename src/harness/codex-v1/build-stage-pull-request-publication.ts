import type { CodexWorkspaceLeaseV1, CodexWorkspaceManagerV1 } from "./workspace";
import type { ObservableGitWorkspacePort } from "./git-workspace-port";
import { inventoryManagedGitWorktreeChangesV1, type WorktreeInventoryGitRunnerV1 }
  from "./git-worktree-change-inventory";
import { createAuthenticatedModelSelectionV1, createPullRequestOpenPortV1,
  createAuthenticatedPublicationDeliveryV1, createPullRequestPublicationPlanV1, createPullRequestPublisherV1,
  type DurablePullRequestPublicationStoreV1, type PullRequestOpenEffectV1 }
  from "../v1/pull-request-publication";
import type { ManagedWorktreeChangeAuditAuthorityV1 } from "../v1/worktree-change-audit-authority";
import { canonicalJson, sha256Digest } from "../../security";
import { controllerWorkerDeliverySchemaV1 } from "../v1/controller-worker-delivery";
import { z } from "zod";
import { assertSynchronousFence } from "../../security/synchronous-fence";

const currentPublicationSchema = z.object({
  deliveryDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  stageKind: z.literal("build"), retainedResultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  modelSelection: z.object({ workerId: z.string().min(1).max(180), model: z.string().min(1).max(180),
    effort: z.string().min(1).max(80) }).strict(),
  repositoryUrl: z.string().url().max(2048), title: z.string().min(1).max(240),
  body: z.string().max(64 * 1024), authorityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  authoritySnapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).strict();

export interface CurrentBuildStagePublicationAuthorityV1 {
  /** Reads the canonical current stage selection and server-owned PR fields. */
  current(delivery: unknown): unknown;
  /** Synchronous protected-state recheck immediately around publication planning. */
  assertCurrent(value: unknown): void;
  /** Fresh controller-side canonical recheck used immediately before the external effect. */
  assertControllerCurrent(value: unknown): Promise<void>;
  /** Optional authenticated build-stage policy; installed S6 composition requires it. */
  workspacePolicy?(delivery: unknown): Readonly<{ allowedPaths: readonly string[];
    maximumChangedFiles: number; maximumChangedBytes: number }>;
}

function currentPublication(authority: CurrentBuildStagePublicationAuthorityV1, deliveryValue: unknown) {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const value = currentPublicationSchema.parse(authority.current(delivery));
  const { authorityDigest, ...material } = value;
  if (value.deliveryDigest !== delivery.deliveryDigest || value.modelSelection.workerId !== delivery.worker.workerId
    || authorityDigest !== sha256Digest(material)) throw new Error("build_stage_publication_authority_unavailable");
  assertSynchronousFence(() => authority.assertCurrent(value), () => {
    throw new Error("build_stage_publication_authority_unavailable");
  });
  return Object.freeze({ ...value, modelSelection: Object.freeze({ ...value.modelSelection }) });
}

/**
 * Production-callable S6 seam. The caller supplies the already-authorized
 * delivery/workspace/audit plan and controller-owned durable/open ports. This
 * function inventories the committed tree, authenticates the selected model,
 * creates the publication plan, and exposes only retained publication.
 */
export async function composeBuildStagePullRequestPublicationV1(input: Readonly<{
  integrityKey: Uint8Array;
  workspaceManager: CodexWorkspaceManagerV1;
  workspacePort: ObservableGitWorkspacePort;
  delivery: unknown;
  lease: CodexWorkspaceLeaseV1;
  auditPlan: unknown;
  auditAuthority: ManagedWorktreeChangeAuditAuthorityV1;
  publicationAuthority: CurrentBuildStagePublicationAuthorityV1;
  runGit: WorktreeInventoryGitRunnerV1;
  store: DurablePullRequestPublicationStoreV1;
  openPullRequest: PullRequestOpenEffectV1;
}>) {
  const current = currentPublication(input.publicationAuthority, input.delivery);
  await input.publicationAuthority.assertControllerCurrent(current);
  const auditEvidence = await inventoryManagedGitWorktreeChangesV1({ workspaceManager: input.workspaceManager,
    workspacePort: input.workspacePort, lease: input.lease, auditPlan: input.auditPlan, runGit: input.runGit });
  const authenticatedModelSelection = createAuthenticatedModelSelectionV1(input.integrityKey,
    input.delivery, current.modelSelection);
  const authenticatedDelivery = createAuthenticatedPublicationDeliveryV1(input.integrityKey, input.delivery);
  const publicationPlan = await createPullRequestPublicationPlanV1({ integrityKey: input.integrityKey,
    workspaceManager: input.workspaceManager, workspacePort: input.workspacePort, authenticatedDelivery,
    lease: input.lease, auditAuthority: input.auditAuthority, auditPlan: input.auditPlan,
    auditEvidence, authenticatedModelSelection,
    retainedResultDigest: current.retainedResultDigest, repositoryUrl: current.repositoryUrl,
    authoritySnapshotDigest: current.authoritySnapshotDigest ?? current.authorityDigest,
    publicationContent: { title: current.title, body: current.body },
    runGit: input.runGit });
  const rechecked = currentPublication(input.publicationAuthority, input.delivery);
  await input.publicationAuthority.assertControllerCurrent(rechecked);
  if (canonicalJson(rechecked) !== canonicalJson(current)) throw new Error("build_stage_publication_authority_changed");
  const publisher = createPullRequestPublisherV1({ integrityKey: input.integrityKey, plan: publicationPlan,
    publicationContent: { title: current.title, body: current.body },
    port: createPullRequestOpenPortV1(input.openPullRequest), store: input.store,
    assertCurrent: async () => {
      const latest = currentPublication(input.publicationAuthority, input.delivery);
      if (canonicalJson(latest) !== canonicalJson(current)) throw new Error("build_stage_publication_authority_changed");
      await input.publicationAuthority.assertControllerCurrent(latest);
    } });
  return Object.freeze({ auditEvidence, publicationPlan,
    publish: publisher.publish.bind(publisher) });
}
