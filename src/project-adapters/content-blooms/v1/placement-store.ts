import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  consequentialApprovalDecisionSchemaV1,
  consequentialApprovalRequestSchemaV1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../../../completion-gate/v1";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import {
  assertContentBloomsPlacementOutcomeBindingV1,
  buildContentBloomsPlacementAmbiguityReceiptV1,
  parseContentBloomsPlacementAuthorizationV1,
  parseContentBloomsPlacementDeclarationV1,
  parseContentBloomsPlacementOutcomeReceiptV1,
  parseContentBloomsPlacementRequestV1,
  requireExactContentBloomsPlacementAuthorizationReplayV1,
  requireExactContentBloomsPlacementOutcomeReplayV1,
  requireExactContentBloomsPlacementRequestReplayV1,
} from "./placement";
import {
  buildContentBloomsPlacementEffectClaimV1,
  buildContentBloomsPlacementTombstoneV1,
  contentBloomsPlacementOutcomeRecordedAtV1,
  parseContentBloomsPlacementEffectClaimV1,
  parseContentBloomsPlacementNodeApprovalEvidenceV1,
  parseContentBloomsPlacementPreEffectMarkerV1,
  parseContentBloomsPlacementTombstoneV1,
  type ContentBloomsPlacementEffectClaimV1,
  type ContentBloomsPlacementNodeApprovalEvidenceV1,
  type ContentBloomsPlacementPreEffectMarkerV1,
  type ContentBloomsPlacementTombstoneV1,
} from "./placement-runtime";
import { contentBloomsSafeIdSchemaV1, contentBloomsTimeSchemaV1 } from "./schemas";
import type {
  ContentBloomsPlacementAuthorizationV1,
  ContentBloomsPlacementDeclarationV1,
  ContentBloomsPlacementOutcomeReceiptV1,
  ContentBloomsPlacementRequestV1,
} from "./types";

type StoredJson = string | Record<string, unknown>;
type PlacementClaimState = "claimed" | "executing" | "accepted" | "already_applied" | "rejected" | "ambiguous";

interface DeclarationRow {
  tenant_id: string; declaration_id: string; declaration_digest: string; workspace_id: string; project_id: string;
  adapter_id: string; release_digest: string; payload: StoredJson; record_auth_tag: string; accepted_at: string | Date;
}
interface RequestRow {
  tenant_id: string; request_id: string; request_digest: string; workspace_id: string; project_id: string; adapter_id: string;
  declaration_digest: string; idempotency_key: string; operation_digest: string; payload: StoredJson; record_auth_tag: string;
  requested_at: string | Date; expires_at: string | Date;
}
interface AuthorizationRow {
  tenant_id: string; authorization_id: string; authorization_digest: string; request_digest: string; approval_request_digest: string;
  approval_decision_digest: string; payload: StoredJson; approval_request_payload: StoredJson; approval_decision_payload: StoredJson;
  record_auth_tag: string; authorized_at: string | Date; expires_at: string | Date;
}
interface NodeEvidenceRow {
  tenant_id: string; evidence_id: string; evidence_digest: string; request_digest: string; operation_digest: string; node_id: string;
  nonce_digest: string; payload: StoredJson; record_auth_tag: string; verified_at: string | Date; expires_at: string | Date;
}
interface ClaimRow {
  tenant_id: string; claim_key: string; claim_id: string; claim_digest: string; request_digest: string; authorization_digest: string;
  node_attestation_digest: string; idempotency_key: string; operation_digest: string; state: PlacementClaimState;
  marker_digest: string | null; outcome_digest: string | null; payload: StoredJson; record_auth_tag: string; version: number | string;
  created_at: string | Date; updated_at: string | Date; effective_deadline: string | Date;
}
interface MarkerRow {
  tenant_id: string; marker_id: string; marker_digest: string; claim_key: string; claim_digest: string; payload: StoredJson;
  record_auth_tag: string; marked_at: string | Date;
}
interface OutcomeRow {
  tenant_id: string; receipt_id: string; receipt_digest: string; claim_key: string; request_digest: string; disposition: PlacementClaimState;
  payload: StoredJson; record_auth_tag: string; recorded_at: string | Date;
}
interface TombstoneRow {
  tenant_id: string; tombstone_id: string; tombstone_digest: string; claim_key: string; request_digest: string;
  idempotency_key: string; outcome_digest: string; disposition: PlacementClaimState; payload: StoredJson; record_auth_tag: string;
  sealed_at: string | Date; retain_until: string | Date;
}

const scopeSchema = z.object({
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
}).strict();

const bundleInputSchema = z.object({
  declaration: z.unknown(),
  request: z.unknown(),
  authorization: z.unknown(),
  approvalRequest: z.unknown(),
  approvalDecision: z.unknown(),
}).strict();

const resolveInputSchema = z.object({
  requestId: contentBloomsSafeIdSchemaV1,
  authorizationId: contentBloomsSafeIdSchemaV1,
  nodeAttestationEvidenceId: contentBloomsSafeIdSchemaV1,
}).strict();

const claimInputSchema = z.object({
  request: z.unknown(), authorization: z.unknown(), nodeAttestationEvidence: z.unknown(), claimedAt: contentBloomsTimeSchemaV1,
}).strict();

const sealInputSchema = z.object({
  claimKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sealedAt: contentBloomsTimeSchemaV1,
  retainUntil: contentBloomsTimeSchemaV1,
  allRetentionHorizonsKnown: z.literal(true),
}).strict();

const declarationColumns = "tenant_id,declaration_id,declaration_digest,workspace_id,project_id,adapter_id,release_digest,payload,record_auth_tag,accepted_at";
const requestColumns = "tenant_id,request_id,request_digest,workspace_id,project_id,adapter_id,declaration_digest,idempotency_key,operation_digest,payload,record_auth_tag,requested_at,expires_at";
const authorizationColumns = "tenant_id,authorization_id,authorization_digest,request_digest,approval_request_digest,approval_decision_digest,payload,approval_request_payload,approval_decision_payload,record_auth_tag,authorized_at,expires_at";
const nodeEvidenceColumns = "tenant_id,evidence_id,evidence_digest,request_digest,operation_digest,node_id,nonce_digest,payload,record_auth_tag,verified_at,expires_at";
const claimColumns = "tenant_id,claim_key,claim_id,claim_digest,request_digest,authorization_digest,node_attestation_digest,idempotency_key,operation_digest,state,marker_digest,outcome_digest,payload,record_auth_tag,version,created_at,updated_at,effective_deadline";
const markerColumns = "tenant_id,marker_id,marker_digest,claim_key,claim_digest,payload,record_auth_tag,marked_at";
const outcomeColumns = "tenant_id,receipt_id,receipt_digest,claim_key,request_digest,disposition,payload,record_auth_tag,recorded_at";
const tombstoneColumns = "tenant_id,tombstone_id,tombstone_digest,claim_key,request_digest,idempotency_key,outcome_digest,disposition,payload,record_auth_tag,sealed_at,retain_until";

function parsedJson(value: StoredJson): unknown { return typeof value === "string" ? JSON.parse(value) : value; }
function json(value: unknown): string { return JSON.stringify(value); }
function iso(value: string | Date): string { return new Date(value).toISOString(); }
function sameTag(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function terminal(state: PlacementClaimState): boolean { return !["claimed", "executing"].includes(state); }

export interface ContentBloomsPlacementDispatchBundleV1 {
  declaration: ContentBloomsPlacementDeclarationV1;
  request: ContentBloomsPlacementRequestV1;
  authorization: ContentBloomsPlacementAuthorizationV1;
  approvalRequest: ConsequentialApprovalRequestV1;
  approvalDecision: ConsequentialApprovalDecisionV1;
  nodeAttestationEvidence: ContentBloomsPlacementNodeApprovalEvidenceV1;
}

export type ContentBloomsPlacementClaimDispositionV1 =
  | { disposition: "dispatch_permitted"; claim: ContentBloomsPlacementEffectClaimV1; created: boolean }
  | { disposition: "in_progress"; claim: ContentBloomsPlacementEffectClaimV1 }
  | { disposition: "replay"; claim: ContentBloomsPlacementEffectClaimV1; outcome: ContentBloomsPlacementOutcomeReceiptV1 };

export class ContentBloomsPlacementStoreV1 {
  readonly #scope: z.infer<typeof scopeSchema>;
  readonly #integrityKey: Uint8Array;

  constructor(private readonly db: DatabaseClient, scopeValue: unknown, integrityKey: Uint8Array) {
    this.#scope = parseExactContentBloomsV1(scopeSchema, scopeValue);
    try {
      hmacSha256Tag(integrityKey, { purpose: "content-blooms-placement-ledger" });
      this.#integrityKey = new Uint8Array(integrityKey);
    } catch {
      throw new ContentBloomsContractErrorV1("invalid_input");
    }
  }

  async registerAuthorizationBundle(inputValue: unknown): Promise<{ replayed: boolean }> {
    const input = parseExactContentBloomsV1(bundleInputSchema, inputValue);
    const declaration = parseContentBloomsPlacementDeclarationV1(input.declaration);
    const request = parseContentBloomsPlacementRequestV1(input.request);
    const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
    let approvalRequest: ConsequentialApprovalRequestV1, approvalDecision: ConsequentialApprovalDecisionV1;
    try {
      approvalRequest = consequentialApprovalRequestSchemaV1.parse(input.approvalRequest) as ConsequentialApprovalRequestV1;
      approvalDecision = consequentialApprovalDecisionSchemaV1.parse(input.approvalDecision) as ConsequentialApprovalDecisionV1;
    } catch { throw new ContentBloomsContractErrorV1("approval_required"); }
    this.assertScope(declaration); this.assertScope(request); this.assertScope(authorization);
    if (request.declarationDigest !== declaration.declarationDigest || request.readReleaseDigest !== declaration.readReleaseDigest
      || authorization.requestDigest !== request.requestDigest || authorization.declarationDigest !== declaration.declarationDigest
      || authorization.approvalRequestId !== approvalRequest.id || authorization.approvalRequestDigest !== sha256Digest(approvalRequest)
      || authorization.approvalDecisionId !== approvalDecision.id || authorization.approvalDecisionDigest !== sha256Digest(approvalDecision)) {
      throw new ContentBloomsContractErrorV1("approval_required");
    }
    return this.db.transaction(async (tx) => {
      const declarationReplay = await this.insertDeclaration(tx, declaration);
      const requestReplay = await this.insertRequest(tx, request);
      const authorizationReplay = await this.insertAuthorization(tx, authorization, approvalRequest, approvalDecision);
      return { replayed: declarationReplay && requestReplay && authorizationReplay };
    });
  }

  async recordNodeAttestationEvidence(value: unknown): Promise<{ evidence: ContentBloomsPlacementNodeApprovalEvidenceV1; replayed: boolean }> {
    const evidence = parseContentBloomsPlacementNodeApprovalEvidenceV1(value); this.assertScope(evidence);
    return this.db.transaction(async (tx) => {
      const request = await this.loadRequestByDigest(tx, evidence.requestDigest);
      if (request.operationDigest !== evidence.operationDigest) throw new ContentBloomsContractErrorV1("approval_required");
      const existing = await tx.query<NodeEvidenceRow>(`SELECT ${nodeEvidenceColumns} FROM control_content_blooms_placement_node_attestations WHERE tenant_id=$1 AND (evidence_id=$2 OR evidence_digest=$3 OR nonce_digest=$4) FOR UPDATE`,
        [this.#scope.tenantId,evidence.evidenceId,evidence.evidenceDigest,evidence.nonceDigest]);
      if (existing.rows[0]) {
        const known = this.verifiedNodeEvidence(existing.rows[0]);
        if (known.evidenceId !== evidence.evidenceId || known.evidenceDigest !== evidence.evidenceDigest) throw new ContentBloomsContractErrorV1("replay_drift");
        return { evidence: known, replayed: true };
      }
      const material = this.nodeEvidenceAuthMaterial(evidence);
      await tx.query(`INSERT INTO control_content_blooms_placement_node_attestations(
        tenant_id,evidence_id,evidence_digest,request_digest,operation_digest,node_id,nonce_digest,payload,record_auth_tag,verified_at,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`, [
        evidence.tenantId,evidence.evidenceId,evidence.evidenceDigest,evidence.requestDigest,evidence.operationDigest,evidence.nodeId,
        evidence.nonceDigest,json(evidence),hmacSha256Tag(this.#integrityKey,material),evidence.verifiedAt,evidence.expiresAt,
      ]);
      return { evidence, replayed: false };
    });
  }

  async resolveDispatchBundle(inputValue: unknown): Promise<ContentBloomsPlacementDispatchBundleV1> {
    const input = parseExactContentBloomsV1(resolveInputSchema, inputValue);
    return this.db.transaction(async (tx) => {
      const requestRow = await tx.query<RequestRow>(`SELECT ${requestColumns} FROM control_content_blooms_placement_requests WHERE tenant_id=$1 AND request_id=$2`,[this.#scope.tenantId,input.requestId]);
      if (!requestRow.rows[0]) throw new ContentBloomsContractErrorV1("invalid_input");
      const request = this.verifiedRequest(requestRow.rows[0]);
      const declaration = await this.loadDeclarationByDigest(tx, request.declarationDigest);
      const authorizationRow = await tx.query<AuthorizationRow>(`SELECT ${authorizationColumns} FROM control_content_blooms_placement_authorizations WHERE tenant_id=$1 AND authorization_id=$2`,[this.#scope.tenantId,input.authorizationId]);
      if (!authorizationRow.rows[0]) throw new ContentBloomsContractErrorV1("approval_required");
      const authorizationBundle = this.verifiedAuthorization(authorizationRow.rows[0]);
      const evidenceRow = await tx.query<NodeEvidenceRow>(`SELECT ${nodeEvidenceColumns} FROM control_content_blooms_placement_node_attestations WHERE tenant_id=$1 AND evidence_id=$2`,[this.#scope.tenantId,input.nodeAttestationEvidenceId]);
      if (!evidenceRow.rows[0]) throw new ContentBloomsContractErrorV1("approval_required");
      const evidence = this.verifiedNodeEvidence(evidenceRow.rows[0]);
      if (authorizationBundle.authorization.requestDigest !== request.requestDigest
        || evidence.requestDigest !== request.requestDigest
        || evidence.authorizationDigest !== authorizationBundle.authorization.authorizationDigest) {
        throw new ContentBloomsContractErrorV1("approval_required");
      }
      return { declaration,request,...authorizationBundle,nodeAttestationEvidence:evidence };
    });
  }

  async claim(inputValue: unknown): Promise<ContentBloomsPlacementClaimDispositionV1> {
    const input = parseExactContentBloomsV1(claimInputSchema, inputValue);
    const request = parseContentBloomsPlacementRequestV1(input.request);
    const authorization = parseContentBloomsPlacementAuthorizationV1(input.authorization);
    const evidence = parseContentBloomsPlacementNodeApprovalEvidenceV1(input.nodeAttestationEvidence);
    this.assertScope(request); this.assertScope(authorization); this.assertScope(evidence);
    const claim = buildContentBloomsPlacementEffectClaimV1({ request,authorization,nodeAttestationEvidence:evidence,claimedAt:input.claimedAt });
    return this.db.transaction(async (tx) => {
      const storedRequest = await this.loadRequestByDigest(tx, request.requestDigest);
      requireExactContentBloomsPlacementRequestReplayV1(storedRequest, request);
      const storedAuthorization = await this.loadAuthorizationByDigest(tx, authorization.authorizationDigest);
      requireExactContentBloomsPlacementAuthorizationReplayV1(storedAuthorization.authorization, authorization);
      const storedEvidence = await this.loadNodeEvidenceByDigest(tx, evidence.evidenceDigest);
      if (storedEvidence.evidenceDigest !== evidence.evidenceDigest) throw new ContentBloomsContractErrorV1("approval_required");
      const existing = await tx.query<ClaimRow>(`SELECT ${claimColumns} FROM control_content_blooms_placement_effect_claims WHERE tenant_id=$1 AND (claim_key=$2 OR request_digest=$3 OR idempotency_key=$4 OR operation_digest=$5) FOR UPDATE`,
        [this.#scope.tenantId,claim.claimKey,claim.requestDigest,claim.idempotencyKey,claim.operationDigest]);
      if (existing.rows[0]) return this.classifyExistingClaim(tx, existing.rows[0], claim);
      const state: PlacementClaimState = "claimed", version = 1;
      const authTag = hmacSha256Tag(this.#integrityKey, this.claimAuthMaterial(claim,state,null,null,version,claim.claimedAt));
      await tx.query(`INSERT INTO control_content_blooms_placement_effect_claims(
        tenant_id,claim_key,claim_id,claim_digest,request_digest,authorization_digest,node_attestation_digest,idempotency_key,
        operation_digest,state,marker_digest,outcome_digest,payload,record_auth_tag,version,created_at,updated_at,effective_deadline
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11::jsonb,$12,$13,$14,$14,$15)`, [
        claim.tenantId,claim.claimKey,claim.claimId,claim.claimDigest,claim.requestDigest,claim.authorizationDigest,
        claim.nodeAttestationEvidenceDigest,claim.idempotencyKey,claim.operationDigest,state,json(claim),authTag,version,
        claim.claimedAt,claim.effectiveDeadline,
      ]);
      return { disposition: "dispatch_permitted", claim, created: true };
    });
  }

  async commitPreEffectMarker(value: unknown): Promise<{ disposition: "committed" | "duplicate"; claim: ContentBloomsPlacementEffectClaimV1 }> {
    const marker = parseContentBloomsPlacementPreEffectMarkerV1(value); this.assertScope(marker);
    return this.db.transaction(async (tx) => {
      const row = await this.loadClaimRow(tx, marker.claimKey, true);
      const claim = this.verifiedClaim(row);
      if (claim.claimDigest !== marker.claimDigest || claim.requestDigest !== marker.requestDigest
        || claim.authorizationDigest !== marker.authorizationDigest || claim.nodeAttestationEvidenceDigest !== marker.nodeAttestationEvidenceDigest
        || claim.operationDigest !== marker.operationDigest || claim.idempotencyKey !== marker.idempotencyKey) {
        throw new ContentBloomsContractErrorV1("replay_drift");
      }
      const existing = await tx.query<MarkerRow>(`SELECT ${markerColumns} FROM control_content_blooms_placement_pre_effect_markers WHERE tenant_id=$1 AND (claim_key=$2 OR marker_id=$3 OR marker_digest=$4)`,
        [this.#scope.tenantId,marker.claimKey,marker.markerId,marker.markerDigest]);
      if (existing.rows[0]) {
        const known = this.verifiedMarker(existing.rows[0]);
        if (known.markerDigest !== marker.markerDigest || row.state !== "executing" || row.marker_digest !== marker.markerDigest) {
          throw new ContentBloomsContractErrorV1("replay_drift");
        }
        return { disposition: "duplicate", claim };
      }
      if (row.state !== "claimed" || row.marker_digest || row.outcome_digest) throw new ContentBloomsContractErrorV1("effect_ambiguous");
      const markerTag = hmacSha256Tag(this.#integrityKey, this.markerAuthMaterial(marker));
      await tx.query(`INSERT INTO control_content_blooms_placement_pre_effect_markers(
        tenant_id,marker_id,marker_digest,claim_key,claim_digest,payload,record_auth_tag,marked_at
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [
        marker.tenantId,marker.markerId,marker.markerDigest,marker.claimKey,marker.claimDigest,json(marker),markerTag,marker.markedAt,
      ]);
      await this.updateClaim(tx,row,claim,"executing",marker.markerDigest,null,marker.markedAt);
      return { disposition: "committed", claim };
    });
  }

  async settleOutcome(claimKey: string, outcomeValue: unknown): Promise<{ outcome: ContentBloomsPlacementOutcomeReceiptV1; replayed: boolean }> {
    const outcome = parseContentBloomsPlacementOutcomeReceiptV1(outcomeValue); this.assertScope(outcome);
    return this.db.transaction(async (tx) => {
      const row = await this.loadClaimRow(tx, claimKey, true), claim = this.verifiedClaim(row);
      const request = await this.loadRequestByDigest(tx, claim.requestDigest);
      const authorization = (await this.loadAuthorizationByDigest(tx, claim.authorizationDigest)).authorization;
      assertContentBloomsPlacementOutcomeBindingV1({ request,authorization,outcome });
      const marker = await this.loadMarkerByClaimKey(tx, claimKey);
      if (outcome.dispatchClaimDigest !== claim.claimDigest || outcome.preEffectMarkerDigest !== marker.markerDigest) {
        throw new ContentBloomsContractErrorV1("replay_drift");
      }
      const existing = await tx.query<OutcomeRow>(`SELECT ${outcomeColumns} FROM control_content_blooms_placement_outcomes WHERE tenant_id=$1 AND (claim_key=$2 OR receipt_id=$3 OR receipt_digest=$4)`,
        [this.#scope.tenantId,claimKey,outcome.receiptId,outcome.receiptDigest]);
      if (existing.rows[0]) {
        const known = this.verifiedOutcome(existing.rows[0]);
        requireExactContentBloomsPlacementOutcomeReplayV1(known, outcome);
        return { outcome: known, replayed: true };
      }
      if (row.state !== "executing" || row.outcome_digest || row.marker_digest !== marker.markerDigest) {
        throw new ContentBloomsContractErrorV1("effect_ambiguous");
      }
      const recordedAt = contentBloomsPlacementOutcomeRecordedAtV1(outcome);
      await tx.query(`INSERT INTO control_content_blooms_placement_outcomes(
        tenant_id,receipt_id,receipt_digest,claim_key,request_digest,disposition,payload,record_auth_tag,recorded_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [
        outcome.tenantId,outcome.receiptId,outcome.receiptDigest,claimKey,outcome.requestDigest,outcome.disposition,json(outcome),
        hmacSha256Tag(this.#integrityKey,this.outcomeAuthMaterial(claimKey,outcome,recordedAt)),recordedAt,
      ]);
      await this.updateClaim(tx,row,claim,outcome.disposition,marker.markerDigest,outcome.receiptDigest,recordedAt);
      return { outcome, replayed: false };
    });
  }

  async recover(claimKey: string, raisedAt: string): Promise<
    | { action: "safe_re_evaluate"; claim: ContentBloomsPlacementEffectClaimV1 }
    | { action: "ambiguous" | "replay_terminal"; claim: ContentBloomsPlacementEffectClaimV1; outcome: ContentBloomsPlacementOutcomeReceiptV1 }
  > {
    return this.db.transaction(async (tx) => {
      const row = await this.loadClaimRow(tx, claimKey, true), claim = this.verifiedClaim(row);
      if (row.state === "claimed" && !row.marker_digest && !row.outcome_digest) return { action: "safe_re_evaluate",claim };
      if (terminal(row.state)) {
        const outcome = await this.loadOutcomeByClaimKey(tx, claimKey);
        return { action: "replay_terminal",claim,outcome };
      }
      const marker = await this.loadMarkerByClaimKey(tx, claimKey);
      const request = await this.loadRequestByDigest(tx, claim.requestDigest);
      const authorization = (await this.loadAuthorizationByDigest(tx, claim.authorizationDigest)).authorization;
      const ambiguity = buildContentBloomsPlacementAmbiguityReceiptV1({
        request,authorization,dispatchClaimDigest:claim.claimDigest,preEffectMarkerDigest:marker.markerDigest,
        ambiguityEvidenceDigest:sha256Digest({ contract:"content-blooms-recovery/v1",claimKey,markerDigest:marker.markerDigest,raisedAt }),
        dispatchedAt:marker.markedAt,raisedAt,
      });
      const recordedAt = ambiguity.raisedAt;
      await tx.query(`INSERT INTO control_content_blooms_placement_outcomes(
        tenant_id,receipt_id,receipt_digest,claim_key,request_digest,disposition,payload,record_auth_tag,recorded_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [
        ambiguity.tenantId,ambiguity.receiptId,ambiguity.receiptDigest,claimKey,ambiguity.requestDigest,ambiguity.disposition,json(ambiguity),
        hmacSha256Tag(this.#integrityKey,this.outcomeAuthMaterial(claimKey,ambiguity,recordedAt)),recordedAt,
      ]);
      await this.updateClaim(tx,row,claim,"ambiguous",marker.markerDigest,ambiguity.receiptDigest,raisedAt);
      return { action: "ambiguous",claim,outcome:ambiguity };
    });
  }

  async sealTombstone(inputValue: unknown): Promise<{ tombstone: ContentBloomsPlacementTombstoneV1; replayed: boolean }> {
    const input = parseExactContentBloomsV1(sealInputSchema, inputValue);
    return this.db.transaction(async (tx) => {
      const row = await this.loadClaimRow(tx,input.claimKey,true), claim = this.verifiedClaim(row);
      if (!terminal(row.state) || !row.outcome_digest) throw new ContentBloomsContractErrorV1("effect_ambiguous");
      const outcome = await this.loadOutcomeByClaimKey(tx,input.claimKey);
      const tombstone = buildContentBloomsPlacementTombstoneV1({ claim,outcome,sealedAt:input.sealedAt,retainUntil:input.retainUntil,allRetentionHorizonsKnown:true });
      const existing = await tx.query<TombstoneRow>(`SELECT ${tombstoneColumns} FROM control_content_blooms_placement_tombstones WHERE tenant_id=$1 AND (claim_key=$2 OR tombstone_id=$3 OR tombstone_digest=$4)`,
        [this.#scope.tenantId,tombstone.claimKey,tombstone.tombstoneId,tombstone.tombstoneDigest]);
      if (existing.rows[0]) {
        const known = this.verifiedTombstone(existing.rows[0]);
        if (known.tombstoneDigest !== tombstone.tombstoneDigest) throw new ContentBloomsContractErrorV1("replay_drift");
        return { tombstone: known,replayed:true };
      }
      await tx.query(`INSERT INTO control_content_blooms_placement_tombstones(
        tenant_id,tombstone_id,tombstone_digest,claim_key,request_digest,idempotency_key,outcome_digest,disposition,payload,record_auth_tag,sealed_at,retain_until
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`, [
        tombstone.tenantId,tombstone.tombstoneId,tombstone.tombstoneDigest,tombstone.claimKey,tombstone.requestDigest,
        tombstone.idempotencyKey,tombstone.outcomeDigest,tombstone.disposition,json(tombstone),
        hmacSha256Tag(this.#integrityKey,this.tombstoneAuthMaterial(tombstone)),tombstone.sealedAt,tombstone.retainUntil,
      ]);
      return { tombstone,replayed:false };
    });
  }

  async loadOutcome(requestId: string): Promise<ContentBloomsPlacementOutcomeReceiptV1 | undefined> {
    const request = await this.db.query<RequestRow>(`SELECT ${requestColumns} FROM control_content_blooms_placement_requests WHERE tenant_id=$1 AND request_id=$2`,[this.#scope.tenantId,requestId]);
    if (!request.rows[0]) return undefined;
    const verified = this.verifiedRequest(request.rows[0]);
    const outcome = await this.db.query<OutcomeRow>(`SELECT ${outcomeColumns} FROM control_content_blooms_placement_outcomes WHERE tenant_id=$1 AND request_digest=$2`,[this.#scope.tenantId,verified.requestDigest]);
    return outcome.rows[0] ? this.verifiedOutcome(outcome.rows[0]) : undefined;
  }

  async counts(): Promise<{ declarations: number; requests: number; authorizations: number; nodeAttestations: number; claims: number; markers: number; outcomes: number; tombstones: number }> {
    const names = ["declarations","requests","authorizations","node_attestations","effect_claims","pre_effect_markers","outcomes","tombstones"] as const;
    const values: number[] = [];
    for (const name of names) {
      const result = await this.db.query<{ count: string | number }>(`SELECT count(*) AS count FROM control_content_blooms_placement_${name} WHERE tenant_id=$1`,[this.#scope.tenantId]);
      values.push(Number(result.rows[0]?.count ?? 0));
    }
    return { declarations:values[0],requests:values[1],authorizations:values[2],nodeAttestations:values[3],claims:values[4],markers:values[5],outcomes:values[6],tombstones:values[7] };
  }

  private assertScope(value: { tenantId:string;workspaceId?:string;projectId:string;adapterId?:string }): void {
    if (value.tenantId !== this.#scope.tenantId || value.projectId !== this.#scope.projectId
      || (value.workspaceId !== undefined && value.workspaceId !== this.#scope.workspaceId)
      || (value.adapterId !== undefined && value.adapterId !== this.#scope.adapterId)) throw new ContentBloomsContractErrorV1("scope_mismatch");
  }

  private async insertDeclaration(tx: DatabaseSession, value: ContentBloomsPlacementDeclarationV1): Promise<boolean> {
    const existing = await tx.query<DeclarationRow>(`SELECT ${declarationColumns} FROM control_content_blooms_placement_declarations WHERE tenant_id=$1 AND (declaration_id=$2 OR declaration_digest=$3) FOR UPDATE`,[value.tenantId,value.declarationId,value.declarationDigest]);
    if (existing.rows[0]) { const known=this.verifiedDeclaration(existing.rows[0]); if(known.declarationDigest!==value.declarationDigest||known.declarationId!==value.declarationId)throw new ContentBloomsContractErrorV1("replay_drift"); return true; }
    const release=await tx.query<{release_digest:string}>("SELECT release_digest FROM control_content_blooms_releases WHERE tenant_id=$1 AND release_digest=$2",[value.tenantId,value.readReleaseDigest]);
    if(!release.rows[0])throw new ContentBloomsContractErrorV1("release_untrusted");
    await tx.query(`INSERT INTO control_content_blooms_placement_declarations(tenant_id,declaration_id,declaration_digest,workspace_id,project_id,adapter_id,release_digest,payload,record_auth_tag,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [value.tenantId,value.declarationId,value.declarationDigest,value.workspaceId,value.projectId,value.adapterId,value.readReleaseDigest,json(value),hmacSha256Tag(this.#integrityKey,this.declarationAuthMaterial(value)),value.acceptedAt]); return false;
  }

  private async insertRequest(tx: DatabaseSession, value: ContentBloomsPlacementRequestV1): Promise<boolean> {
    const existing=await tx.query<RequestRow>(`SELECT ${requestColumns} FROM control_content_blooms_placement_requests WHERE tenant_id=$1 AND (request_id=$2 OR request_digest=$3 OR idempotency_key=$4 OR operation_digest=$5) FOR UPDATE`,[value.tenantId,value.requestId,value.requestDigest,value.idempotencyKey,value.operationDigest]);
    if(existing.rows[0]){const known=this.verifiedRequest(existing.rows[0]);requireExactContentBloomsPlacementRequestReplayV1(known,value);return true;}
    await tx.query(`INSERT INTO control_content_blooms_placement_requests(tenant_id,request_id,request_digest,workspace_id,project_id,adapter_id,declaration_digest,idempotency_key,operation_digest,payload,record_auth_tag,requested_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
      [value.tenantId,value.requestId,value.requestDigest,value.workspaceId,value.projectId,value.adapterId,value.declarationDigest,value.idempotencyKey,value.operationDigest,json(value),hmacSha256Tag(this.#integrityKey,this.requestAuthMaterial(value)),value.requestedAt,value.expiresAt]);return false;
  }

  private async insertAuthorization(tx: DatabaseSession,value:ContentBloomsPlacementAuthorizationV1,approvalRequest:ConsequentialApprovalRequestV1,approvalDecision:ConsequentialApprovalDecisionV1):Promise<boolean>{
    const existing=await tx.query<AuthorizationRow>(`SELECT ${authorizationColumns} FROM control_content_blooms_placement_authorizations WHERE tenant_id=$1 AND (authorization_id=$2 OR authorization_digest=$3 OR request_digest=$4) FOR UPDATE`,[value.tenantId,value.authorizationId,value.authorizationDigest,value.requestDigest]);
    if(existing.rows[0]){const known=this.verifiedAuthorization(existing.rows[0]);requireExactContentBloomsPlacementAuthorizationReplayV1(known.authorization,value);if(sha256Digest(known.approvalRequest)!==sha256Digest(approvalRequest)||sha256Digest(known.approvalDecision)!==sha256Digest(approvalDecision))throw new ContentBloomsContractErrorV1("replay_drift");return true;}
    await tx.query(`INSERT INTO control_content_blooms_placement_authorizations(tenant_id,authorization_id,authorization_digest,request_digest,approval_request_digest,approval_decision_digest,payload,approval_request_payload,approval_decision_payload,record_auth_tag,authorized_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)`,
      [value.tenantId,value.authorizationId,value.authorizationDigest,value.requestDigest,value.approvalRequestDigest,value.approvalDecisionDigest,json(value),json(approvalRequest),json(approvalDecision),hmacSha256Tag(this.#integrityKey,this.authorizationAuthMaterial(value,approvalRequest,approvalDecision)),value.authorizedAt,value.expiresAt]);return false;
  }

  private verifiedDeclaration(row:DeclarationRow):ContentBloomsPlacementDeclarationV1{const value=parseContentBloomsPlacementDeclarationV1(parsedJson(row.payload));if(row.tenant_id!==value.tenantId||row.declaration_id!==value.declarationId||row.declaration_digest!==value.declarationDigest||row.workspace_id!==value.workspaceId||row.project_id!==value.projectId||row.adapter_id!==value.adapterId||row.release_digest!==value.readReleaseDigest||iso(row.accepted_at)!==value.acceptedAt||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.declarationAuthMaterial(value))))throw new ContentBloomsContractErrorV1("replay_drift");this.assertScope(value);return value;}
  private verifiedRequest(row:RequestRow):ContentBloomsPlacementRequestV1{const value=parseContentBloomsPlacementRequestV1(parsedJson(row.payload));if(row.tenant_id!==value.tenantId||row.request_id!==value.requestId||row.request_digest!==value.requestDigest||row.workspace_id!==value.workspaceId||row.project_id!==value.projectId||row.adapter_id!==value.adapterId||row.declaration_digest!==value.declarationDigest||row.idempotency_key!==value.idempotencyKey||row.operation_digest!==value.operationDigest||iso(row.requested_at)!==value.requestedAt||iso(row.expires_at)!==value.expiresAt||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.requestAuthMaterial(value))))throw new ContentBloomsContractErrorV1("replay_drift");this.assertScope(value);return value;}
  private verifiedAuthorization(row:AuthorizationRow):{authorization:ContentBloomsPlacementAuthorizationV1;approvalRequest:ConsequentialApprovalRequestV1;approvalDecision:ConsequentialApprovalDecisionV1}{const authorization=parseContentBloomsPlacementAuthorizationV1(parsedJson(row.payload));let approvalRequest:ConsequentialApprovalRequestV1,approvalDecision:ConsequentialApprovalDecisionV1;try{approvalRequest=consequentialApprovalRequestSchemaV1.parse(parsedJson(row.approval_request_payload)) as ConsequentialApprovalRequestV1;approvalDecision=consequentialApprovalDecisionSchemaV1.parse(parsedJson(row.approval_decision_payload)) as ConsequentialApprovalDecisionV1;}catch{throw new ContentBloomsContractErrorV1("replay_drift");}if(row.tenant_id!==authorization.tenantId||row.authorization_id!==authorization.authorizationId||row.authorization_digest!==authorization.authorizationDigest||row.request_digest!==authorization.requestDigest||row.approval_request_digest!==sha256Digest(approvalRequest)||row.approval_decision_digest!==sha256Digest(approvalDecision)||authorization.approvalRequestDigest!==row.approval_request_digest||authorization.approvalDecisionDigest!==row.approval_decision_digest||iso(row.authorized_at)!==authorization.authorizedAt||iso(row.expires_at)!==authorization.expiresAt||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.authorizationAuthMaterial(authorization,approvalRequest,approvalDecision))))throw new ContentBloomsContractErrorV1("replay_drift");this.assertScope(authorization);return{authorization,approvalRequest,approvalDecision};}
  private verifiedNodeEvidence(row:NodeEvidenceRow):ContentBloomsPlacementNodeApprovalEvidenceV1{const value=parseContentBloomsPlacementNodeApprovalEvidenceV1(parsedJson(row.payload));if(row.tenant_id!==value.tenantId||row.evidence_id!==value.evidenceId||row.evidence_digest!==value.evidenceDigest||row.request_digest!==value.requestDigest||row.operation_digest!==value.operationDigest||row.node_id!==value.nodeId||row.nonce_digest!==value.nonceDigest||iso(row.verified_at)!==value.verifiedAt||iso(row.expires_at)!==value.expiresAt||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.nodeEvidenceAuthMaterial(value))))throw new ContentBloomsContractErrorV1("replay_drift");this.assertScope(value);return value;}
  private verifiedClaim(row:ClaimRow):ContentBloomsPlacementEffectClaimV1{const value=parseContentBloomsPlacementEffectClaimV1(parsedJson(row.payload));if(row.tenant_id!==value.tenantId||row.claim_key!==value.claimKey||row.claim_id!==value.claimId||row.claim_digest!==value.claimDigest||row.request_digest!==value.requestDigest||row.authorization_digest!==value.authorizationDigest||row.node_attestation_digest!==value.nodeAttestationEvidenceDigest||row.idempotency_key!==value.idempotencyKey||row.operation_digest!==value.operationDigest||iso(row.created_at)!==value.claimedAt||iso(row.effective_deadline)!==value.effectiveDeadline||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.claimAuthMaterial(value,row.state,row.marker_digest,row.outcome_digest,Number(row.version),iso(row.updated_at)))))throw new ContentBloomsContractErrorV1("replay_drift");this.assertScope(value);return value;}
  private verifiedMarker(row:MarkerRow):ContentBloomsPlacementPreEffectMarkerV1{const value=parseContentBloomsPlacementPreEffectMarkerV1(parsedJson(row.payload));if(row.tenant_id!==value.tenantId||row.marker_id!==value.markerId||row.marker_digest!==value.markerDigest||row.claim_key!==value.claimKey||row.claim_digest!==value.claimDigest||iso(row.marked_at)!==value.markedAt||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.markerAuthMaterial(value))))throw new ContentBloomsContractErrorV1("replay_drift");this.assertScope(value);return value;}
  private verifiedOutcome(row:OutcomeRow):ContentBloomsPlacementOutcomeReceiptV1{const value=parseContentBloomsPlacementOutcomeReceiptV1(parsedJson(row.payload));if(row.tenant_id!==value.tenantId||row.receipt_id!==value.receiptId||row.receipt_digest!==value.receiptDigest||row.request_digest!==value.requestDigest||row.disposition!==value.disposition||iso(row.recorded_at)!==contentBloomsPlacementOutcomeRecordedAtV1(value)||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.outcomeAuthMaterial(row.claim_key,value,iso(row.recorded_at)))))throw new ContentBloomsContractErrorV1("replay_drift");this.assertScope(value);return value;}
  private verifiedTombstone(row:TombstoneRow):ContentBloomsPlacementTombstoneV1{const value=parseContentBloomsPlacementTombstoneV1(parsedJson(row.payload));if(row.tenant_id!==value.tenantId||row.tombstone_id!==value.tombstoneId||row.tombstone_digest!==value.tombstoneDigest||row.claim_key!==value.claimKey||row.request_digest!==value.requestDigest||row.idempotency_key!==value.idempotencyKey||row.outcome_digest!==value.outcomeDigest||row.disposition!==value.disposition||iso(row.sealed_at)!==value.sealedAt||iso(row.retain_until)!==value.retainUntil||!sameTag(row.record_auth_tag,hmacSha256Tag(this.#integrityKey,this.tombstoneAuthMaterial(value))))throw new ContentBloomsContractErrorV1("replay_drift");return value;}

  private declarationAuthMaterial(v:ContentBloomsPlacementDeclarationV1){return{kind:"declaration",tenantId:v.tenantId,id:v.declarationId,digest:v.declarationDigest,releaseDigest:v.readReleaseDigest,payloadDigest:sha256Digest(v),acceptedAt:v.acceptedAt};}
  private requestAuthMaterial(v:ContentBloomsPlacementRequestV1){return{kind:"request",tenantId:v.tenantId,id:v.requestId,digest:v.requestDigest,declarationDigest:v.declarationDigest,idempotencyKey:v.idempotencyKey,operationDigest:v.operationDigest,payloadDigest:sha256Digest(v),requestedAt:v.requestedAt,expiresAt:v.expiresAt};}
  private authorizationAuthMaterial(v:ContentBloomsPlacementAuthorizationV1,r:ConsequentialApprovalRequestV1,d:ConsequentialApprovalDecisionV1){return{kind:"authorization",tenantId:v.tenantId,id:v.authorizationId,digest:v.authorizationDigest,requestDigest:v.requestDigest,approvalRequestDigest:sha256Digest(r),approvalDecisionDigest:sha256Digest(d),payloadDigest:sha256Digest(v),authorizedAt:v.authorizedAt,expiresAt:v.expiresAt};}
  private nodeEvidenceAuthMaterial(v:ContentBloomsPlacementNodeApprovalEvidenceV1){return{kind:"node_attestation",tenantId:v.tenantId,id:v.evidenceId,digest:v.evidenceDigest,requestDigest:v.requestDigest,operationDigest:v.operationDigest,nodeId:v.nodeId,nonceDigest:v.nonceDigest,payloadDigest:sha256Digest(v),verifiedAt:v.verifiedAt,expiresAt:v.expiresAt};}
  private claimAuthMaterial(v:ContentBloomsPlacementEffectClaimV1,state:PlacementClaimState,markerDigest:string|null,outcomeDigest:string|null,version:number,updatedAt:string){return{kind:"effect_claim",tenantId:v.tenantId,claimKey:v.claimKey,claimDigest:v.claimDigest,requestDigest:v.requestDigest,authorizationDigest:v.authorizationDigest,nodeAttestationDigest:v.nodeAttestationEvidenceDigest,idempotencyKey:v.idempotencyKey,operationDigest:v.operationDigest,state,markerDigest,outcomeDigest,version,payloadDigest:sha256Digest(v),createdAt:v.claimedAt,updatedAt,effectiveDeadline:v.effectiveDeadline};}
  private markerAuthMaterial(v:ContentBloomsPlacementPreEffectMarkerV1){return{kind:"pre_effect_marker",tenantId:v.tenantId,id:v.markerId,digest:v.markerDigest,claimKey:v.claimKey,claimDigest:v.claimDigest,payloadDigest:sha256Digest(v),markedAt:v.markedAt};}
  private outcomeAuthMaterial(claimKey:string,v:ContentBloomsPlacementOutcomeReceiptV1,recordedAt:string){return{kind:"outcome",tenantId:v.tenantId,id:v.receiptId,digest:v.receiptDigest,claimKey,requestDigest:v.requestDigest,disposition:v.disposition,payloadDigest:sha256Digest(v),recordedAt};}
  private tombstoneAuthMaterial(v:ContentBloomsPlacementTombstoneV1){return{kind:"tombstone",tenantId:v.tenantId,id:v.tombstoneId,digest:v.tombstoneDigest,claimKey:v.claimKey,requestDigest:v.requestDigest,idempotencyKey:v.idempotencyKey,outcomeDigest:v.outcomeDigest,disposition:v.disposition,payloadDigest:sha256Digest(v),sealedAt:v.sealedAt,retainUntil:v.retainUntil};}

  private async classifyExistingClaim(tx:DatabaseSession,row:ClaimRow,candidate:ContentBloomsPlacementEffectClaimV1):Promise<ContentBloomsPlacementClaimDispositionV1>{const known=this.verifiedClaim(row);if(known.claimDigest!==candidate.claimDigest)throw new ContentBloomsContractErrorV1("replay_drift");if(row.state==="claimed"&&!row.marker_digest&&!row.outcome_digest)return{disposition:"dispatch_permitted",claim:known,created:false};if(row.state==="executing"&&!row.outcome_digest)return{disposition:"in_progress",claim:known};if(terminal(row.state)&&row.outcome_digest)return{disposition:"replay",claim:known,outcome:await this.loadOutcomeByClaimKey(tx,row.claim_key)};throw new ContentBloomsContractErrorV1("replay_drift");}
  private async updateClaim(tx:DatabaseSession,row:ClaimRow,claim:ContentBloomsPlacementEffectClaimV1,state:PlacementClaimState,markerDigest:string|null,outcomeDigest:string|null,updatedAt:string):Promise<void>{const version=Number(row.version)+1,auth=hmacSha256Tag(this.#integrityKey,this.claimAuthMaterial(claim,state,markerDigest,outcomeDigest,version,updatedAt));const result=await tx.query<{claim_key:string}>(`UPDATE control_content_blooms_placement_effect_claims SET state=$1,marker_digest=$2,outcome_digest=$3,record_auth_tag=$4,version=$5,updated_at=$6 WHERE tenant_id=$7 AND claim_key=$8 AND version=$9 RETURNING claim_key`,[state,markerDigest,outcomeDigest,auth,version,updatedAt,this.#scope.tenantId,claim.claimKey,Number(row.version)]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("replay_drift");}
  private async loadClaimRow(tx:DatabaseSession,claimKey:string,lock:boolean):Promise<ClaimRow>{const result=await tx.query<ClaimRow>(`SELECT ${claimColumns} FROM control_content_blooms_placement_effect_claims WHERE tenant_id=$1 AND claim_key=$2${lock?" FOR UPDATE":""}`,[this.#scope.tenantId,claimKey]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("invalid_input");return result.rows[0];}
  private async loadDeclarationByDigest(tx:DatabaseSession,digest:string){const result=await tx.query<DeclarationRow>(`SELECT ${declarationColumns} FROM control_content_blooms_placement_declarations WHERE tenant_id=$1 AND declaration_digest=$2`,[this.#scope.tenantId,digest]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("release_untrusted");return this.verifiedDeclaration(result.rows[0]);}
  private async loadRequestByDigest(tx:DatabaseSession,digest:string){const result=await tx.query<RequestRow>(`SELECT ${requestColumns} FROM control_content_blooms_placement_requests WHERE tenant_id=$1 AND request_digest=$2`,[this.#scope.tenantId,digest]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("invalid_input");return this.verifiedRequest(result.rows[0]);}
  private async loadAuthorizationByDigest(tx:DatabaseSession,digest:string){const result=await tx.query<AuthorizationRow>(`SELECT ${authorizationColumns} FROM control_content_blooms_placement_authorizations WHERE tenant_id=$1 AND authorization_digest=$2`,[this.#scope.tenantId,digest]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("approval_required");return this.verifiedAuthorization(result.rows[0]);}
  private async loadNodeEvidenceByDigest(tx:DatabaseSession,digest:string){const result=await tx.query<NodeEvidenceRow>(`SELECT ${nodeEvidenceColumns} FROM control_content_blooms_placement_node_attestations WHERE tenant_id=$1 AND evidence_digest=$2`,[this.#scope.tenantId,digest]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("approval_required");return this.verifiedNodeEvidence(result.rows[0]);}
  private async loadMarkerByClaimKey(tx:DatabaseSession,claimKey:string){const result=await tx.query<MarkerRow>(`SELECT ${markerColumns} FROM control_content_blooms_placement_pre_effect_markers WHERE tenant_id=$1 AND claim_key=$2`,[this.#scope.tenantId,claimKey]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("effect_ambiguous");return this.verifiedMarker(result.rows[0]);}
  private async loadOutcomeByClaimKey(tx:DatabaseSession,claimKey:string){const result=await tx.query<OutcomeRow>(`SELECT ${outcomeColumns} FROM control_content_blooms_placement_outcomes WHERE tenant_id=$1 AND claim_key=$2`,[this.#scope.tenantId,claimKey]);if(!result.rows[0])throw new ContentBloomsContractErrorV1("effect_ambiguous");return this.verifiedOutcome(result.rows[0]);}
}
