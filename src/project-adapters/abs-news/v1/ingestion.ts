import { sha256Digest } from "../../../security";
import { exactHostDataArrayV1, isHostProxyV1 } from "../../../security/host-value";
import { z } from "zod";
import { ProjectWorkspaceContractErrorV1, parseExactProjectWorkspaceV1, projectWorkspaceSafeIdSchemaV1, projectWorkspaceTimeSchemaV1 } from "../../../project-workspace/v1";
import { AbsNewsInjectedFakeCollectorV1, collectAbsNewsFakeSourcesV1 } from "./collection";
import { SqliteAbsNewsStoreV1 } from "./store";
import type { AbsNewsFakeIngestionReceiptV1 } from "./types";

const ingestionInputSchema = z.object({ tenantId: projectWorkspaceSafeIdSchemaV1, workspaceId: projectWorkspaceSafeIdSchemaV1, projectId: projectWorkspaceSafeIdSchemaV1, collectedAt: projectWorkspaceTimeSchemaV1 }).strict();

export class AbsNewsFakeIngestionServiceV1 {
  readonly #collectors: AbsNewsInjectedFakeCollectorV1[];
  constructor(readonly store: SqliteAbsNewsStoreV1, collectorsValue: unknown) {
    if (isHostProxyV1(collectorsValue)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const collectors = exactHostDataArrayV1(collectorsValue, 100);
    if (!collectors || collectors.some((collector) => isHostProxyV1(collector) || !(collector instanceof AbsNewsInjectedFakeCollectorV1))) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    this.#collectors = [...collectors] as AbsNewsInjectedFakeCollectorV1[];
  }

  run(inputValue: unknown): AbsNewsFakeIngestionReceiptV1 {
    const input = parseExactProjectWorkspaceV1(ingestionInputSchema, inputValue);
    const batches = this.#collectors.map((collector) => collector.collect());
    const result = collectAbsNewsFakeSourcesV1({ ...input, batches });
    const persisted = this.store.ingestStories(result.stories, result.collectedAt);
    for (const batch of batches) this.store.saveSourceStatus({
      sourceId: batch.sourceId,
      sourceKind: batch.sourceKind,
      label: batch.sourceLabel,
      mode: "synthetic",
      state: "available",
      safeStatusCode: "injected_fixture_collected",
      checkedAt: batch.collectedAt,
      lastSuccessfulAt: batch.collectedAt,
      itemCount: batch.items.length,
      grantsNetworkAuthority: false,
    }, result.collectedAt);
    const material = {
      resultDigest: result.resultDigest,
      batchDigests: result.batchDigests,
      insertedStoryCount: persisted.inserted,
      replayedStoryCount: persisted.replayed,
      sourceStatusCount: batches.length,
      collectedAt: result.collectedAt,
      synthetic: true as const,
      networkUsed: false as const,
      createsWorkItem: false as const,
      grantsApproval: false as const,
      grantsNetworkAuthority: false as const,
      grantsCommandAuthority: false as const,
      grantsExecutionAuthority: false as const,
    };
    return { ...material, receiptDigest: sha256Digest(material) };
  }
}
