import { sha256Digest } from "../../../security";
import { exactHostDataArrayV1, type HostResultCollectorV1 } from "../../../security/host-value";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseContentBloomsOperationalRecordV1, buildContentBloomsOperationalRecordV1 } from "./records";
import type {
  ContentBloomsOperationalRecordV1,
  ContentBloomsReadOperationV1,
  ContentBloomsReadRequestV1,
  ContentBloomsRecordKindV1,
} from "./types";

const kindForOperation: Partial<Record<ContentBloomsReadOperationV1, ContentBloomsRecordKindV1>> = {
  getProjectSummary: "project",
  listWorkItems: "work_item",
  listExecutions: "execution",
  listBlockers: "blocker",
  listWorkers: "worker",
  listAttentionItems: "attention",
};

export interface ContentBloomsFixturePageInputV1 {
  pageId: string;
  nextCursor: string;
  hasMore: boolean;
  sourceSnapshotVersion: string;
  sourceObservedAt: string;
  records: ContentBloomsOperationalRecordV1[];
}

export interface ContentBloomsReadSourceV1 {
  read(request: ContentBloomsReadRequestV1, collector: HostResultCollectorV1): void;
}

function fixtureRecord(
  kind: ContentBloomsRecordKindV1,
  sourceRecordId: string,
  projection: Record<string, unknown>,
  sourceVersion = "1",
): ContentBloomsOperationalRecordV1 {
  return buildContentBloomsOperationalRecordV1({
    kind,
    operation: "upsert",
    tenantId: "tenant:owner",
    workspaceId: "workspace:content-blooms",
    projectId: "project:content-blooms:operations",
    adapterId: "adapter:content-blooms:v1",
    sourceRecordId,
    sourceVersion,
    observedAt: "2026-08-29T13:05:00.000Z",
    projection,
  });
}

export function buildContentBloomsSyntheticFixtureRecordsV1(): ContentBloomsOperationalRecordV1[] {
  const sourceLeaseOwnerDigest = sha256Digest({ source: "content-blooms", leaseOwner: "synthetic-worker-mac" });
  return [
    fixtureRecord("project", "content-operations", {
      title: "Content Operations",
      normalizedState: "blocked",
      domainState: "mixed_queue",
      health: "at_risk",
      progressPercent: 62,
      forecastAt: "2026-08-30T18:00:00.000Z",
      attentionCount: 2,
      blockerCount: 2,
      priority: 90,
      deepLinkPath: "/operations",
    }, "42"),
    fixtureRecord("work_item", "recording-queue-1042", {
      title: "Synthetic recording awaiting transcription route",
      normalizedState: "ready",
      domainState: "transcription_capacity",
      priority: 95,
      requiredCapability: "transcription:whisper",
      allowedRouteIds: ["route:mac:mlx", "route:windows:cuda", "route:vps:cpu"],
      downstreamUnlockCount: 3,
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T13:00:00.000Z",
      deepLinkPath: "/operations/recording-queue-1042",
    }, "12"),
    fixtureRecord("work_item", "research-plan-882", {
      title: "Synthetic research plan",
      normalizedState: "running",
      domainState: "researching",
      priority: 75,
      progressPercent: 40,
      requiredCapability: "research:web",
      downstreamUnlockCount: 2,
      createdAt: "2026-08-29T11:00:00.000Z",
      updatedAt: "2026-08-29T13:01:00.000Z",
      deepLinkPath: "/operations/research-plan-882",
    }, "5"),
    fixtureRecord("work_item", "customer-input-331", {
      title: "Synthetic customer input required",
      normalizedState: "blocked",
      domainState: "customer_input_required",
      priority: 80,
      blockedBySourceRecordIds: ["customer-input-331"],
      createdAt: "2026-08-29T10:00:00.000Z",
      updatedAt: "2026-08-29T12:55:00.000Z",
      deepLinkPath: "/operations/customer-input-331",
    }, "2"),
    fixtureRecord("work_item", "draft-review-447", {
      title: "Synthetic draft awaiting operator review",
      normalizedState: "review",
      domainState: "awaiting_operator_review",
      priority: 85,
      progressPercent: 90,
      requiredCapability: "review:content",
      createdAt: "2026-08-29T09:00:00.000Z",
      updatedAt: "2026-08-29T12:58:00.000Z",
      deepLinkPath: "/operations/draft-review-447",
    }, "4"),
    fixtureRecord("execution", "transcription-attempt-1", {
      workItemSourceRecordId: "recording-queue-1042",
      attempt: 1,
      state: "leased",
      routeId: "route:mac:mlx",
      progressPercent: 15,
      sourceLeaseOwnerDigest,
      sourceLeaseEpoch: 7,
      leaseObservedAt: "2026-08-29T13:02:00.000Z",
      startedAt: "2026-08-29T13:02:30.000Z",
    }, "3"),
    fixtureRecord("blocker", "transcription-capacity-1042", {
      workItemSourceRecordId: "recording-queue-1042",
      blockerType: "route_capacity",
      title: "Synthetic preferred route capacity conflict",
      severity: "warning",
      responsibleRole: "system",
      safeRemedy: "Compare verified source-visible transcription routes.",
      openedAt: "2026-08-29T13:00:00.000Z",
      deepLinkPath: "/operations/recording-queue-1042",
    }, "2"),
    fixtureRecord("blocker", "customer-input-blocker-331", {
      workItemSourceRecordId: "customer-input-331",
      blockerType: "customer_input",
      title: "Synthetic customer decision pending",
      severity: "warning",
      responsibleRole: "customer",
      safeRemedy: "Wait for the source-owned customer response.",
      openedAt: "2026-08-29T12:55:00.000Z",
      deepLinkPath: "/operations/customer-input-331",
    }, "1"),
    fixtureRecord("worker", "source-worker-mac", {
      workerRefDigest: sha256Digest({ sourceWorker: "mac" }),
      displayLabel: "Mac transcription route",
      platform: "macos",
      state: "busy",
      routeIds: ["route:mac:mlx"],
      observedAt: "2026-08-29T13:04:00.000Z",
    }, "6"),
    fixtureRecord("worker", "source-worker-windows", {
      workerRefDigest: sha256Digest({ sourceWorker: "windows" }),
      displayLabel: "Windows transcription route",
      platform: "windows",
      state: "idle",
      routeIds: ["route:windows:cuda"],
      observedAt: "2026-08-29T13:04:00.000Z",
    }, "8"),
    fixtureRecord("worker", "source-worker-vps", {
      workerRefDigest: sha256Digest({ sourceWorker: "vps" }),
      displayLabel: "VPS transcription route",
      platform: "linux",
      state: "idle",
      routeIds: ["route:vps:cpu"],
      observedAt: "2026-08-29T13:04:00.000Z",
    }, "5"),
    fixtureRecord("attention", "route-decision-1042", {
      workItemSourceRecordId: "recording-queue-1042",
      attentionType: "decision",
      title: "Choose a source transcription preference",
      summary: "Compare three verified synthetic routes; Content Blooms makes the placement decision.",
      createdAt: "2026-08-29T13:01:00.000Z",
      deepLinkPath: "/operations/recording-queue-1042",
    }, "3"),
    fixtureRecord("attention", "draft-review-447", {
      workItemSourceRecordId: "draft-review-447",
      attentionType: "review",
      title: "Synthetic draft review requested",
      summary: "Review operational status in the protected source screen.",
      dueAt: "2026-08-30T16:00:00.000Z",
      createdAt: "2026-08-29T12:58:00.000Z",
      deepLinkPath: "/operations/draft-review-447",
    }, "1"),
  ];
}

function cursorFor(operation: ContentBloomsReadOperationV1, offset: number, snapshotDigest: string): string {
  return `cbf.${operation}.${offset}.${snapshotDigest.slice(7, 23)}`;
}

export class ContentBloomsFixtureSourceV1 implements ContentBloomsReadSourceV1 {
  readonly #records: ContentBloomsOperationalRecordV1[];
  readonly #snapshotDigest: string;

  constructor(recordsValue: unknown = buildContentBloomsSyntheticFixtureRecordsV1()) {
    const records = exactHostDataArrayV1(recordsValue, 1_000);
    if (!records) throw new ContentBloomsContractErrorV1("invalid_input");
    this.#records = records.map((record) => parseContentBloomsOperationalRecordV1(record));
    this.#snapshotDigest = sha256Digest(this.#records.map((record) => record.recordDigest));
  }

  read(request: ContentBloomsReadRequestV1, collector: HostResultCollectorV1): void {
    const expectedKind = kindForOperation[request.operation];
    const available = this.#records.filter((record) => request.operation === "readChanges" || record.kind === expectedKind);
    let offset = 0;
    if (request.afterCursor) {
      const parts = request.afterCursor.split(".");
      if (parts.length !== 4 || parts[0] !== "cbf" || parts[1] !== request.operation
        || parts[3] !== this.#snapshotDigest.slice(7, 23) || !/^\d+$/.test(parts[2])) {
        throw new ContentBloomsContractErrorV1("cursor_drift");
      }
      offset = Number(parts[2]);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > available.length) {
        throw new ContentBloomsContractErrorV1("cursor_drift");
      }
    }
    const records = available.slice(offset, offset + request.limit);
    const nextOffset = offset + records.length;
    const nextCursor = cursorFor(request.operation, nextOffset, this.#snapshotDigest);
    const latestRecordTime = records.reduce((latest, record) => Math.max(latest, Date.parse(record.observedAt)), Date.parse(request.requestedAt));
    const page: ContentBloomsFixturePageInputV1 = {
      pageId: `page:cb-fixture:${sha256Digest({ requestDigest: request.requestDigest, nextCursor }).slice(7, 39)}`,
      nextCursor,
      hasMore: nextOffset < available.length,
      sourceSnapshotVersion: `fixture:${this.#snapshotDigest}`,
      sourceObservedAt: new Date(latestRecordTime).toISOString(),
      records,
    };
    collector.submit(page);
  }
}
