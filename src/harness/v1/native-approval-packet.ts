import { z } from "zod";
import { ownerApprovalAttestationSchema } from "../../node-policy/v1/schemas";
import { digestSchema, localId } from "./native-run-identifiers";

const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeRecoveryPermissionBodySchema = z.object({
  schema: z.literal("control-room.native-run-recovery-permission/v1"),
  bindingDigest: digestSchema, approvalKeyId: localId, issuedAt: instant, expiresAt: instant,
  operations: z.tuple([z.literal("status"), z.literal("stop")]),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), bodyDigest: digestSchema,
}).strict();
export type NativeRecoveryPermissionBody = z.infer<typeof nativeRecoveryPermissionBodySchema>;
export const nativeRecoveryPermissionSchema = z.object({ body: nativeRecoveryPermissionBodySchema,
  signatureAlgorithm: z.literal("Ed25519"), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export const nativeTaskApprovalPacketSchema = z.object({ schema: z.literal("control-room.native-task-approval-packet/v1"),
  approval: ownerApprovalAttestationSchema, recovery: nativeRecoveryPermissionSchema }).strict();
export type NativeTaskApprovalPacket = z.infer<typeof nativeTaskApprovalPacketSchema>;
