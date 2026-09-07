import { z } from "zod";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { privateResponseHeaders, readBoundedJson } from "./http-common";
import { nativeTaskApprovalPacketSchema } from "../../harness/v1/native-approval-packet";
import { approvalDigestSchema, taskApprovalReadSchema, taskApprovalReviewSchema, taskApprovalSavedSchema } from "./task-approval-wire";
import type { TaskApprovalOperation } from "./task-coordinator-lifecycle";
import type { WebTaskService } from "./task-service";
import { sha256Digest } from "../../security";
import { describeNativeOwnerReview } from "../../harness/v1/native-owner-review";

const draftSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), expectedInputDigest: approvalDigestSchema }).strict(),
  z.object({ action: z.literal("store"), expectedInputDigest: approvalDigestSchema, packet: nativeTaskApprovalPacketSchema }).strict(),
]);
/** Called only after the shared HTTP boundary verifies origin, edge identity and path IDs. */
export async function taskApprovalHttp(request: Request, identity: VerifiedWebIdentity, projectId: string, jobId: string,
  service: WebTaskService, operation?: TaskApprovalOperation) {
  await service.authorize(identity, projectId);
  if (!operation) throw new Error("task_approval_not_configured");
  const url = new URL(request.url);
  if (request.method === "GET") {
    if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has("inputDigest")) throw new WebAccessError("invalid_request");
    const input = approvalDigestSchema.safeParse(url.searchParams.get("inputDigest"));
    if (!input.success) throw new WebAccessError("invalid_request");
    const receipt = await operation.read(identity, projectId, jobId, input.data);
    const value = taskApprovalReadSchema.parse({ projectId, jobId, inputDigest: input.data, receipt });
    if (receipt && (receipt.projectId !== projectId || receipt.jobId !== jobId)) throw new Error("approval_scope_mismatch");
    return Response.json(value, { headers: privateResponseHeaders });
  }
  if (request.method !== "POST") throw new WebAccessError("not_found");
  if (url.search || request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body)
    throw new WebAccessError("invalid_request");
  const draft = draftSchema.safeParse(await readBoundedJson(request.body, 32_768));
  if (!draft.success || request.signal.aborted) throw new WebAccessError("invalid_request");
  const inputDigest = draft.data.expectedInputDigest;
  if (draft.data.action === "prepare") {
    const p = await operation.prepare(identity, projectId, jobId, inputDigest);
    if (p.request.projectId !== projectId || p.request.jobId !== jobId || p.inputDigest !== inputDigest
      || p.start.projectId !== projectId || p.start.jobId !== jobId || p.start.attemptId !== p.request.attemptId
      || p.start.nodeId !== p.request.nodeId || p.start.nodeId !== p.enrollment.nodeId
      || p.start.operationDigest !== p.request.operationDigest || p.request.approval
      || p.startsWork !== false || p.grantsExecutionAuthority !== false) throw new Error("approval_scope_mismatch");
    const value = taskApprovalReviewSchema.parse(describeNativeOwnerReview(p));
    if (value.inputDigest !== inputDigest) throw new Error("approval_scope_mismatch");
    return Response.json(value, { headers: privateResponseHeaders });
  }
  const receipt = await operation.store(identity, projectId, jobId, inputDigest, draft.data.packet, request.signal);
  if (receipt.projectId !== projectId || receipt.jobId !== jobId || receipt.packetDigest !== sha256Digest(draft.data.packet)
    || receipt.operationDigest !== draft.data.packet.approval.body.operationDigest
    || receipt.attemptId !== draft.data.packet.approval.body.attemptId) throw new Error("approval_scope_mismatch");
  const value = taskApprovalSavedSchema.parse({ projectId, jobId, inputDigest, receipt });
  return Response.json(value, { status: receipt.replayed ? 200 : 201, headers: privateResponseHeaders });
}
