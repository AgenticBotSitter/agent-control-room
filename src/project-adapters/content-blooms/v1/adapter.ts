import { z } from "zod";
import { createHostResultCollectorV1, dataMethodV1 } from "../../../security/host-value";
import { parseContentBloomsControlStateV1 } from "./control";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import type { ContentBloomsReadSourceV1 } from "./fixture";
import { parseContentBloomsAdapterReleaseV1 } from "./release";
import { buildContentBloomsReadPageV1, buildContentBloomsReadReceiptV1, parseContentBloomsReadRequestV1 } from "./read";
import { contentBloomsTimeSchemaV1 } from "./schemas";
import type { ContentBloomsValidatedReadV1 } from "./types";

const adapterReadInputSchemaV1 = z.object({
  request: z.unknown(),
  release: z.unknown(),
  controlState: z.unknown(),
  recordedAt: contentBloomsTimeSchemaV1,
}).strict();

export class ContentBloomsInjectedReadAdapterV1 {
  readonly #read: ContentBloomsReadSourceV1["read"];
  readonly #source: object;

  constructor(source: ContentBloomsReadSourceV1) {
    const method = dataMethodV1(source, "read");
    if (!method) throw new ContentBloomsContractErrorV1("invalid_input");
    this.#read = method as ContentBloomsReadSourceV1["read"];
    this.#source = source;
  }

  read(inputValue: unknown): ContentBloomsValidatedReadV1 {
    const input = parseExactContentBloomsV1(adapterReadInputSchemaV1, inputValue);
    const request = parseContentBloomsReadRequestV1(input.request);
    const release = parseContentBloomsAdapterReleaseV1(input.release);
    const controlState = parseContentBloomsControlStateV1(input.controlState);
    const sameScope = [release, controlState].every((value) => value.tenantId === request.tenantId
      && value.workspaceId === request.workspaceId && value.projectId === request.projectId
      && value.adapterId === request.adapterId);
    if (!sameScope) throw new ContentBloomsContractErrorV1("scope_mismatch");
    if (request.expectedReleaseDigest !== release.releaseDigest
      || controlState.status !== "enabled" || !controlState.readsEligible
      || controlState.activeReleaseDigest !== release.releaseDigest) {
      throw new ContentBloomsContractErrorV1("adapter_disabled");
    }
    const handoff = createHostResultCollectorV1();
    let candidate: unknown;
    try {
      const returned = Reflect.apply(this.#read, this.#source, [request, handoff.collector]);
      if (returned !== undefined) throw new ContentBloomsContractErrorV1("source_unavailable");
      candidate = handoff.take();
    } catch (error) {
      handoff.abort();
      if (error instanceof ContentBloomsContractErrorV1) throw error;
      throw new ContentBloomsContractErrorV1("source_unavailable");
    }
    const raw = parseExactContentBloomsV1(z.object({
      pageId: z.unknown(),
      nextCursor: z.unknown(),
      hasMore: z.unknown(),
      sourceSnapshotVersion: z.unknown(),
      sourceObservedAt: z.unknown(),
      records: z.unknown(),
    }).strict(), candidate);
    const page = buildContentBloomsReadPageV1({
      request,
      release,
      pageId: raw.pageId,
      nextCursor: raw.nextCursor,
      hasMore: raw.hasMore,
      sourceSnapshotVersion: raw.sourceSnapshotVersion,
      sourceObservedAt: raw.sourceObservedAt,
      records: raw.records,
    });
    return buildContentBloomsReadReceiptV1({
      request,
      page,
      release,
      controlState,
      recordedAt: input.recordedAt,
    });
  }
}
