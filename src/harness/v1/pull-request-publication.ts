import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertNoSecretMaterial, canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import type { ObservableGitWorkspacePort } from "../codex-v1/git-workspace-port";
import type { CodexWorkspaceLeaseV1, CodexWorkspaceManagerV1 } from "../codex-v1/workspace";
import { controllerWorkerDeliverySchemaV1 } from "./controller-worker-delivery";
import { verifyWorktreeChangeAuditEvidenceV1, verifyWorktreeChangeAuditPlanV1 } from "./worktree-change-audit";
import type { ManagedWorktreeChangeAuditAuthorityV1 } from "./worktree-change-audit-authority";
import { assertSynchronousFence } from "../../security/synchronous-fence";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), tag = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const modelSelectionSchema = z.object({ workerId: z.string().min(1).max(180),
  model: z.string().min(1).max(180), effort: z.string().min(1).max(80) }).strict();
const authenticatedModelSchema = z.object({ deliveryDigest: digest, modelSelection: modelSelectionSchema,
  authenticationTag: tag }).strict();
const authenticatedDeliverySchema = z.object({ delivery: controllerWorkerDeliverySchemaV1,
  authenticationTag: tag }).strict();
const publicationContentSchema = z.object({ title: z.string().min(1).max(240),
  body: z.string().max(64 * 1024) }).strict();
const planMaterialSchema = z.object({ schema: z.literal("control-room.pull-request-publication-plan/v1"),
  deliveryDigest: digest, worktreeLeaseDigest: digest, worktreeAuditPlanDigest: digest,
  worktreeAuditEvidenceDigest: digest, commitDigest: commit, repositoryUrl: z.string().url().max(2048),
  modelSelection: modelSelectionSchema, retainedResultDigest: digest, publicationContentDigest: digest }).strict();
const planSchema = planMaterialSchema.extend({ planDigest: digest, authenticationTag: tag }).strict();
const evidenceMaterialSchema = z.object({ schema: z.literal("control-room.pull-request-publication-evidence/v1"),
  planDigest: digest, deliveryDigest: digest, worktreeAuditEvidenceDigest: digest,
  retainedResultDigest: digest, url: z.string().url().max(2048), commitDigest: commit, modelSelection: modelSelectionSchema,
  usage: z.literal("unknown") }).strict();
const evidenceSchema = evidenceMaterialSchema.extend({ evidenceDigest: digest, authenticationTag: tag }).strict();
const recordMaterialSchema = z.object({ schema: z.literal("control-room.pull-request-publication-record/v1"),
  publicationId: z.string().regex(/^publication:[a-f0-9]{64}$/), planDigest: digest,
  deliveryDigest: digest, state: z.enum(["pending", "published", "reconciliation_required"]),
  evidence: evidenceSchema.nullable() }).strict();
const recordSchema = recordMaterialSchema.extend({ authenticationTag: tag }).strict();

export type AuthenticatedModelSelectionV1 = Readonly<z.infer<typeof authenticatedModelSchema>>;
export type AuthenticatedPublicationDeliveryV1 = Readonly<z.infer<typeof authenticatedDeliverySchema>>;
export type PullRequestPublicationPlanV1 = Readonly<z.infer<typeof planSchema>>;
export type PullRequestPublicationEvidenceV1 = Readonly<z.infer<typeof evidenceSchema>>;
export type PullRequestPublicationResultV1 = Readonly<{ status: "published"; evidence: PullRequestPublicationEvidenceV1 }
  | { status: "reconciliation_required" }>;
export interface DurablePullRequestPublicationStoreV1 {
  load(publicationId: string): Promise<unknown | undefined>;
  reserve(publicationId: string, pendingRecord: unknown): Promise<"reserved" | "exists">;
  replace(publicationId: string, expectedPendingRecord: unknown, terminalRecord: unknown): Promise<boolean>;
}

declare const openPortBrand: unique symbol;
export type PullRequestOpenPortV1 = Readonly<{ [openPortBrand]: true }>;
export type PullRequestOpenEffectV1 = (input: Readonly<{ title: string; body: string; commitDigest: string }>) => Promise<Readonly<
  { status: "opened"; url: string; observedCommit: string } | { status: "ambiguous" }>>;
const openEffects = new WeakMap<object, PullRequestOpenEffectV1>();
const unavailable = (): never => { throw new Error("pull_request_publication_unavailable"); };
function sameTag(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}
function requireAllowedPullRequestUrl(value: string, repositoryUrl: string): string {
  let candidate: URL, repository: URL;
  try { candidate = new URL(value); repository = new URL(repositoryUrl); } catch { return unavailable(); }
  if (candidate.protocol !== "https:" || repository.protocol !== "https:" || candidate.username || candidate.password
    || candidate.search || candidate.hash || repository.username || repository.password || repository.search || repository.hash) unavailable();
  const root = repository.pathname.replace(/\/$/, "");
  if (!root || candidate.origin !== repository.origin
    || !new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9][0-9]*$`).test(candidate.pathname)) unavailable();
  return candidate.toString();
}
const auth = (key: Uint8Array, purpose: string, value: unknown) => hmacSha256Tag(key, { purpose, value });

function parsePublicationContent(value: unknown) {
  const content = publicationContentSchema.parse(value);
  assertNoSecretMaterial(content, "pull request publication content");
  return Object.freeze({ ...content });
}

/** Constructs an unforgeable, null-prototype, open-only capability. */
export function createPullRequestOpenPortV1(effect: PullRequestOpenEffectV1): PullRequestOpenPortV1 {
  if (typeof effect !== "function") unavailable();
  const capability = Object.create(null) as object;
  openEffects.set(capability, effect);
  return Object.freeze(capability) as PullRequestOpenPortV1;
}

export function createAuthenticatedModelSelectionV1(integrityKey: Uint8Array, deliveryValue: unknown,
  selectionValue: unknown): AuthenticatedModelSelectionV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue), modelSelection = modelSelectionSchema.parse(selectionValue);
  if (modelSelection.workerId !== delivery.worker.workerId) unavailable();
  const material = { deliveryDigest: delivery.deliveryDigest, modelSelection };
  return Object.freeze({ ...material, modelSelection: Object.freeze({ ...modelSelection }),
    authenticationTag: auth(integrityKey, "pull-request-model-selection/v1", material) });
}
export function createAuthenticatedPublicationDeliveryV1(integrityKey: Uint8Array,
  deliveryValue: unknown): AuthenticatedPublicationDeliveryV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  return Object.freeze({ delivery,
    authenticationTag: auth(integrityKey, "pull-request-publication-delivery/v1", delivery) });
}
function verifyAuthenticatedDelivery(key: Uint8Array, value: unknown) {
  const parsed = authenticatedDeliverySchema.parse(value);
  if (!sameTag(parsed.authenticationTag,
    auth(key, "pull-request-publication-delivery/v1", parsed.delivery))) unavailable();
  return parsed.delivery;
}
function verifyAuthenticatedModel(key: Uint8Array, deliveryDigest: string, value: unknown) {
  const parsed = authenticatedModelSchema.parse(value);
  const material = { deliveryDigest: parsed.deliveryDigest, modelSelection: parsed.modelSelection };
  if (parsed.deliveryDigest !== deliveryDigest
    || !sameTag(parsed.authenticationTag, auth(key, "pull-request-model-selection/v1", material))) unavailable();
  return parsed;
}

/** Server-only plan creation rechecks physical roots, checkout, clean HEAD and prior evidence bindings. */
export async function createPullRequestPublicationPlanV1(input: Readonly<{
  integrityKey: Uint8Array; workspaceManager: CodexWorkspaceManagerV1; workspacePort: ObservableGitWorkspacePort;
  authenticatedDelivery: unknown; lease: CodexWorkspaceLeaseV1; auditAuthority: ManagedWorktreeChangeAuditAuthorityV1;
  auditPlan: unknown; auditEvidence: unknown;
  authenticatedModelSelection: unknown; retainedResultDigest: string; repositoryUrl: string; publicationContent: unknown;
  runGit(cwd: string, args: readonly string[]): Promise<Uint8Array>;
}>): Promise<PullRequestPublicationPlanV1> {
  const delivery = verifyAuthenticatedDelivery(input.integrityKey, input.authenticatedDelivery);
  const lease = input.workspaceManager.requireActiveLease(input.lease);
  if (delivery.deliveryDigest !== lease.deliveryDigest || delivery.identity.runId !== lease.runId) unavailable();
  const auditPlan = verifyWorktreeChangeAuditPlanV1(input.auditPlan);
  const derivedAuditPlan = input.auditAuthority.derive({ delivery, lease });
  if (canonicalJson(derivedAuditPlan) !== canonicalJson(auditPlan)) unavailable();
  const evidence = verifyWorktreeChangeAuditEvidenceV1(auditPlan, input.auditEvidence);
  if (auditPlan.deliveryDigest !== delivery.deliveryDigest || auditPlan.worktreeLeaseDigest !== lease.leaseId) unavailable();
  const selected = verifyAuthenticatedModel(input.integrityKey, delivery.deliveryDigest, input.authenticatedModelSelection);
  const publicationContent = parsePublicationContent(input.publicationContent);
  requireAllowedPullRequestUrl(`${input.repositoryUrl.replace(/\/$/, "")}/pull/1`, input.repositoryUrl);
  const roots = await input.workspacePort.inspectRootIdentities(), checkout = await input.workspacePort.inspectExisting(lease.checkoutPath);
  if (roots.repository.realPath !== lease.repositoryRealPath || roots.repository.device !== lease.repositoryDevice
    || roots.repository.inode !== lease.repositoryInode || checkout.realPath !== lease.checkoutPath
    || checkout.device !== lease.device || checkout.inode !== lease.inode) unavailable();
  const head = Buffer.from(await input.runGit(lease.checkoutPath, ["--no-optional-locks", "rev-parse", "HEAD"])).toString("utf8").trim();
  const status = Buffer.from(await input.runGit(lease.checkoutPath,
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"])).toString("utf8");
  if (!/^[a-f0-9]{40}$/.test(head) || head === lease.revision || head !== evidence.headRevision || status.trim()) unavailable();
  const afterRoots = await input.workspacePort.inspectRootIdentities();
  const afterCheckout = await input.workspacePort.inspectExisting(lease.checkoutPath);
  const afterHead = Buffer.from(await input.runGit(lease.checkoutPath,
    ["--no-optional-locks", "rev-parse", "HEAD"])).toString("utf8").trim();
  const afterStatus = Buffer.from(await input.runGit(lease.checkoutPath,
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching"])).toString("utf8");
  if (afterHead !== head || afterStatus.trim() || canonicalJson(afterRoots) !== canonicalJson(roots)
    || canonicalJson(afterCheckout) !== canonicalJson(checkout)) unavailable();
  const material = planMaterialSchema.parse({ schema: "control-room.pull-request-publication-plan/v1",
    deliveryDigest: delivery.deliveryDigest, worktreeLeaseDigest: lease.leaseId,
    worktreeAuditPlanDigest: auditPlan.planDigest, worktreeAuditEvidenceDigest: evidence.evidenceDigest,
    commitDigest: head, repositoryUrl: input.repositoryUrl, modelSelection: selected.modelSelection,
    retainedResultDigest: digest.parse(input.retainedResultDigest),
    publicationContentDigest: sha256Digest(publicationContent) });
  const planDigest = sha256Digest(material), signed = { ...material, planDigest };
  return Object.freeze({ ...signed, modelSelection: Object.freeze({ ...material.modelSelection }),
    authenticationTag: auth(input.integrityKey, "pull-request-publication-plan/v1", signed) });
}

function verifyPlan(key: Uint8Array, value: unknown): PullRequestPublicationPlanV1 {
  const plan = planSchema.parse(value), { authenticationTag, ...signed } = plan;
  const { planDigest, ...material } = signed;
  if (planDigest !== sha256Digest(material)
    || !sameTag(authenticationTag, auth(key, "pull-request-publication-plan/v1", signed))) unavailable();
  requireAllowedPullRequestUrl(`${plan.repositoryUrl.replace(/\/$/, "")}/pull/1`, plan.repositoryUrl);
  return plan;
}
function makeRecord(key: Uint8Array, plan: PullRequestPublicationPlanV1,
  state: "pending" | "published" | "reconciliation_required", evidence: PullRequestPublicationEvidenceV1 | null) {
  const material = recordMaterialSchema.parse({ schema: "control-room.pull-request-publication-record/v1",
    publicationId: `publication:${plan.planDigest.slice(7)}`, planDigest: plan.planDigest,
    deliveryDigest: plan.deliveryDigest, state, evidence });
  return Object.freeze({ ...material, authenticationTag: auth(key, "pull-request-publication-record/v1", material) });
}
function verifyRecord(key: Uint8Array, plan: PullRequestPublicationPlanV1, value: unknown) {
  const parsed = recordSchema.parse(value), { authenticationTag, ...material } = parsed;
  if (parsed.publicationId !== `publication:${plan.planDigest.slice(7)}` || parsed.planDigest !== plan.planDigest
    || parsed.deliveryDigest !== plan.deliveryDigest
    || !sameTag(authenticationTag, auth(key, "pull-request-publication-record/v1", material))) unavailable();
  return parsed;
}

/** Durable intent is reserved before the single open effect; pending always reconciles after restart. */
export function createPullRequestPublisherV1(input: Readonly<{ integrityKey: Uint8Array;
  plan: unknown; publicationContent: unknown; port: PullRequestOpenPortV1; store: DurablePullRequestPublicationStoreV1;
  assertCurrent(): void;
}>): Readonly<{ publish(): Promise<PullRequestPublicationResultV1> }> {
  const plan = verifyPlan(input.integrityKey, input.plan), candidateEffect = openEffects.get(input.port as object);
  if (candidateEffect === undefined) throw new Error("pull_request_publication_unavailable");
  if (!input.store || typeof input.assertCurrent !== "function") unavailable();
  const content = parsePublicationContent(input.publicationContent);
  if (sha256Digest(content) !== plan.publicationContentDigest) unavailable();
  const effect: PullRequestOpenEffectV1 = candidateEffect;
  const publicationId = `publication:${plan.planDigest.slice(7)}`;
  const assertCurrent = () => assertSynchronousFence(input.assertCurrent, unavailable);
  return Object.freeze({ async publish(): Promise<PullRequestPublicationResultV1> {
    const priorValue = await input.store.load(publicationId);
    if (priorValue !== undefined) {
      const prior = verifyRecord(input.integrityKey, plan, priorValue);
      if (prior.state === "published" && prior.evidence) return Object.freeze({ status: "published", evidence: prior.evidence });
      return Object.freeze({ status: "reconciliation_required" });
    }
    assertCurrent();
    const pending = makeRecord(input.integrityKey, plan, "pending", null);
    if (await input.store.reserve(publicationId, pending) !== "reserved") {
      const raced = await input.store.load(publicationId); if (raced === undefined) unavailable();
      const verified = verifyRecord(input.integrityKey, plan, raced);
      return verified.state === "published" && verified.evidence
        ? Object.freeze({ status: "published", evidence: verified.evidence })
        : Object.freeze({ status: "reconciliation_required" });
    }
    assertCurrent();
    let opened: Awaited<ReturnType<PullRequestOpenEffectV1>>;
    try { opened = await effect(Object.freeze({ ...content, commitDigest: plan.commitDigest })); }
    catch { return Object.freeze({ status: "reconciliation_required" }); }
    if (opened.status === "ambiguous" || opened.observedCommit !== plan.commitDigest) {
      await input.store.replace(publicationId, pending, makeRecord(input.integrityKey, plan, "reconciliation_required", null)).catch(() => false);
      return Object.freeze({ status: "reconciliation_required" });
    }
    let url: string;
    try { url = requireAllowedPullRequestUrl(opened.url, plan.repositoryUrl); }
    catch { await input.store.replace(publicationId, pending, makeRecord(input.integrityKey, plan, "reconciliation_required", null)).catch(() => false);
      return Object.freeze({ status: "reconciliation_required" }); }
    const material = evidenceMaterialSchema.parse({ schema: "control-room.pull-request-publication-evidence/v1",
      planDigest: plan.planDigest, deliveryDigest: plan.deliveryDigest,
      worktreeAuditEvidenceDigest: plan.worktreeAuditEvidenceDigest,
      retainedResultDigest: plan.retainedResultDigest, url, commitDigest: plan.commitDigest,
      modelSelection: plan.modelSelection, usage: "unknown" });
    const evidenceDigest = sha256Digest(material);
    const evidence = Object.freeze({ ...material, modelSelection: Object.freeze({ ...material.modelSelection }),
      evidenceDigest, authenticationTag: auth(input.integrityKey, "pull-request-publication-evidence/v1",
        { ...material, evidenceDigest }) });
    const published = makeRecord(input.integrityKey, plan, "published", evidence);
    if (!await input.store.replace(publicationId, pending, published)) return Object.freeze({ status: "reconciliation_required" });
    return Object.freeze({ status: "published", evidence });
  } });
}

export function verifyPullRequestPublicationEvidenceV1(value: unknown, planValue: unknown,
  integrityKey: Uint8Array): PullRequestPublicationEvidenceV1 {
  const plan = verifyPlan(integrityKey, planValue), parsed = evidenceSchema.parse(value);
  const { evidenceDigest, ...material } = parsed;
  const { authenticationTag, ...unsignedMaterial } = material;
  if (evidenceDigest !== sha256Digest(unsignedMaterial)
    || !sameTag(authenticationTag, auth(integrityKey, "pull-request-publication-evidence/v1",
      { ...unsignedMaterial, evidenceDigest })) || parsed.planDigest !== plan.planDigest
    || parsed.deliveryDigest !== plan.deliveryDigest || parsed.commitDigest !== plan.commitDigest
    || parsed.retainedResultDigest !== plan.retainedResultDigest
    || parsed.worktreeAuditEvidenceDigest !== plan.worktreeAuditEvidenceDigest
    || canonicalJson(parsed.modelSelection) !== canonicalJson(plan.modelSelection)) unavailable();
  requireAllowedPullRequestUrl(parsed.url, plan.repositoryUrl);
  return Object.freeze({ ...parsed, modelSelection: Object.freeze({ ...parsed.modelSelection }) });
}
