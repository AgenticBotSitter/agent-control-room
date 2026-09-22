import { sha256Digest } from "../../security/canonical-digest";
import { FIRST_OWNER_ACTION_TERMINAL_CONFIRMATION_V1, prepareFirstOwnerActionTransactionRequestV1,
  type FirstOwnerActionRequestV1, type FirstOwnerActionTerminalConfirmationV1 } from
  "./first-owner-action-transaction";

/**
 * Source-only owner-attended runner for the retained first-owner ceremony.
 * The real ceremony, owner observation, and ceremony close remain injected
 * private ports. This module accepts no assertion, code, credential, database,
 * listener, filesystem, process, or native transport capability.
 */
export const PRIVATE_FIRST_OWNER_RUNNER_V1 = "control-room.private-first-owner-runner/v1" as const;
export const PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1 =
  "control-room.private-first-owner-installation-binding/v1" as const;
export const PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1 =
  "control-room.private-first-owner-attached-terminal/v1" as const;
export const PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1 =
  "control-room.private-first-owner-existing-owner-evidence/v1" as const;
export const PRIVATE_FIRST_OWNER_CLEANUP_V1 = "control-room.private-first-owner-cleanup/v1" as const;

export type PrivateFirstOwnerInstallationBindingV1 = Readonly<{
  schema: typeof PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1;
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  releaseDigest: string;
  databaseAuthorityOutcomeDigest: string;
  expectedOwnerSubjectDigest: string;
}>;

export type PrivateFirstOwnerRunnerContextV1 = Readonly<{
  request: FirstOwnerActionRequestV1;
  requestDigest: string;
  binding: PrivateFirstOwnerInstallationBindingV1;
  signal: AbortSignal;
}>;

export type PrivateFirstOwnerAttachedTerminalV1 = Readonly<{
  schema: typeof PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1;
  installationId: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  releaseDigest: string;
  databaseAuthorityOutcomeDigest: string;
  expectedOwnerSubjectDigest: string;
  ownerAttached: true;
  confirmed: true;
}>;

/** Exact sanitized success body emitted by the retained ceremony. */
export type PrivateFirstOwnerCeremonyCompletionV1 = Readonly<{
  schema: "control-room.owner-bootstrap-complete/v1";
  ownerCreated: true;
  normalApplicationAvailable: true;
  physicalGatewayAcceptanceComplete: false;
}>;

export type PrivateFirstOwnerExistingOwnerEvidenceV1 = Readonly<{
  schema: typeof PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1;
  installationId: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  releaseDigest: string;
  databaseAuthorityOutcomeDigest: string;
  expectedOwnerSubjectDigest: string;
  ownerConfirmed: true;
  ownerState: "existing";
  ownerProofDigest: string;
  ceremonyOutcomeDigest: string;
  outcome: "verified";
}>;

export type PrivateFirstOwnerRunnerResultV1 = Readonly<{
  schema: typeof PRIVATE_FIRST_OWNER_RUNNER_V1;
  installationId: string;
  requestDigest: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  releaseDigest: string;
  databaseAuthorityOutcomeDigest: string;
  expectedOwnerSubjectDigest: string;
  ownerState: "existing";
  ownerProofDigest: string;
  ceremonyOutcomeDigest: string;
  disposition: "terminal_confirmation";
  terminalConfirmation: FirstOwnerActionTerminalConfirmationV1;
  cleanupConfirmed: true;
}>;

export type PrivateFirstOwnerRuntimeV1 = Readonly<{
  binding: PrivateFirstOwnerInstallationBindingV1;
  signal: AbortSignal;
  controlDeadlineMs: number;
  cleanupDeadlineMs: number;
  confirmOwnerAttachedTerminal(context: PrivateFirstOwnerRunnerContextV1): Promise<PrivateFirstOwnerAttachedTerminalV1>;
  /** Production must compose createOwnerBootstrapCeremonyV1; this port receives no raw assertion or code. */
  runRetainedOwnerBootstrapCeremony(context: PrivateFirstOwnerRunnerContextV1): Promise<PrivateFirstOwnerCeremonyCompletionV1>;
  /** Production independently reads the exact expected subject after ceremony completion. */
  verifyExistingOwner(context: PrivateFirstOwnerRunnerContextV1 & Readonly<{
    ceremonyOutcomeDigest: string;
  }>): Promise<PrivateFirstOwnerExistingOwnerEvidenceV1>;
  /** May only close the retained ceremony and release its already-owned resources. */
  cleanupRetainedOwnerBootstrapCeremony(context: Omit<PrivateFirstOwnerRunnerContextV1, "signal"> & Readonly<{
    signal: AbortSignal;
    scope: "retained_owner_bootstrap_ceremony";
  }>): Promise<Readonly<{
    schema: typeof PRIVATE_FIRST_OWNER_CLEANUP_V1;
    installationId: string;
    requestDigest: string;
    scope: "retained_owner_bootstrap_ceremony";
    outcome: "confirmed";
  }>>;
}>;

type FailureKind = "refused" | "uncertain";
const failureKinds = new WeakMap<object, FailureKind>();
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;

function sanitizedError(kind: FailureKind): Error {
  const error = new Error(`private_first_owner_runner_${kind}`);
  error.stack = undefined;
  failureKinds.set(error, kind);
  return error;
}

function failureKind(value: unknown): FailureKind | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? failureKinds.get(value as object) : undefined;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw sanitizedError("refused");
  const result = value as Readonly<Record<string, unknown>>;
  if (Object.getOwnPropertyNames(result).some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(result, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) throw sanitizedError("refused");
  return result;
}

function exactRecord(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  const result = plainRecord(value), keys = Object.keys(result);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !Object.prototype.hasOwnProperty.call(result, name))) throw sanitizedError("refused");
  return result;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) throw sanitizedError("refused");
  return value;
}

function captureBinding(value: unknown): PrivateFirstOwnerInstallationBindingV1 {
  const binding = exactRecord(value, ["schema", "installationId", "installationPlanDigest", "installationPlanRevision",
    "releaseDigest", "databaseAuthorityOutcomeDigest", "expectedOwnerSubjectDigest"]);
  if (binding.schema !== PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1
    || typeof binding.installationId !== "string" || !installationIdPattern.test(binding.installationId)
    || !Number.isSafeInteger(binding.installationPlanRevision) || (binding.installationPlanRevision as number) < 0) {
    throw sanitizedError("refused");
  }
  return Object.freeze({ schema: PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1,
    installationId: binding.installationId, installationPlanDigest: digest(binding.installationPlanDigest),
    installationPlanRevision: binding.installationPlanRevision as number, releaseDigest: digest(binding.releaseDigest),
    databaseAuthorityOutcomeDigest: digest(binding.databaseAuthorityOutcomeDigest),
    expectedOwnerSubjectDigest: digest(binding.expectedOwnerSubjectDigest) });
}

function deadline(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 30_000) throw sanitizedError("refused");
  return value as number;
}

function signal(value: unknown): AbortSignal {
  if (!value || typeof value !== "object" || typeof (value as AbortSignal).aborted !== "boolean"
    || typeof (value as AbortSignal).addEventListener !== "function"
    || typeof (value as AbortSignal).removeEventListener !== "function") throw sanitizedError("refused");
  return value as AbortSignal;
}

function captureRuntime(value: unknown): PrivateFirstOwnerRuntimeV1 {
  const runtime = exactRecord(value, ["binding", "signal", "controlDeadlineMs", "cleanupDeadlineMs",
    "confirmOwnerAttachedTerminal", "runRetainedOwnerBootstrapCeremony", "verifyExistingOwner",
    "cleanupRetainedOwnerBootstrapCeremony"]);
  for (const name of ["confirmOwnerAttachedTerminal", "runRetainedOwnerBootstrapCeremony", "verifyExistingOwner",
    "cleanupRetainedOwnerBootstrapCeremony"] as const) {
    if (typeof runtime[name] !== "function") throw sanitizedError("refused");
  }
  return Object.freeze({ binding: captureBinding(runtime.binding), signal: signal(runtime.signal),
    controlDeadlineMs: deadline(runtime.controlDeadlineMs), cleanupDeadlineMs: deadline(runtime.cleanupDeadlineMs),
    confirmOwnerAttachedTerminal: runtime.confirmOwnerAttachedTerminal as PrivateFirstOwnerRuntimeV1["confirmOwnerAttachedTerminal"],
    runRetainedOwnerBootstrapCeremony:
      runtime.runRetainedOwnerBootstrapCeremony as PrivateFirstOwnerRuntimeV1["runRetainedOwnerBootstrapCeremony"],
    verifyExistingOwner: runtime.verifyExistingOwner as PrivateFirstOwnerRuntimeV1["verifyExistingOwner"],
    cleanupRetainedOwnerBootstrapCeremony:
      runtime.cleanupRetainedOwnerBootstrapCeremony as PrivateFirstOwnerRuntimeV1["cleanupRetainedOwnerBootstrapCeremony"] });
}

function requestDigest(request: FirstOwnerActionRequestV1): string {
  return sha256Digest({ purpose: "first-owner-action-request/v1", request });
}

function assertBinding(request: FirstOwnerActionRequestV1, binding: PrivateFirstOwnerInstallationBindingV1): void {
  if (binding.installationPlanDigest !== request.installationPlanDigest
    || binding.installationPlanRevision !== request.installationPlanRevision
    || binding.releaseDigest !== request.releaseDigest
    || binding.databaseAuthorityOutcomeDigest !== request.databaseAuthorityOutcomeDigest
    || binding.expectedOwnerSubjectDigest !== request.expectedOwnerSubjectDigest) throw sanitizedError("refused");
}

function assertAttached(value: unknown, context: PrivateFirstOwnerRunnerContextV1): void {
  const result = exactRecord(value, ["schema", "installationId", "requestDigest", "installationPlanDigest",
    "installationPlanRevision", "releaseDigest", "databaseAuthorityOutcomeDigest", "expectedOwnerSubjectDigest",
    "ownerAttached", "confirmed"]);
  const binding = context.binding;
  if (result.schema !== PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1 || result.installationId !== binding.installationId
    || result.requestDigest !== context.requestDigest || result.installationPlanDigest !== binding.installationPlanDigest
    || result.installationPlanRevision !== binding.installationPlanRevision || result.releaseDigest !== binding.releaseDigest
    || result.databaseAuthorityOutcomeDigest !== binding.databaseAuthorityOutcomeDigest
    || result.expectedOwnerSubjectDigest !== binding.expectedOwnerSubjectDigest
    || result.ownerAttached !== true || result.confirmed !== true) throw sanitizedError("refused");
}

function completion(value: unknown): PrivateFirstOwnerCeremonyCompletionV1 {
  const result = exactRecord(value, ["schema", "ownerCreated", "normalApplicationAvailable",
    "physicalGatewayAcceptanceComplete"]);
  if (result.schema !== "control-room.owner-bootstrap-complete/v1" || result.ownerCreated !== true
    || result.normalApplicationAvailable !== true || result.physicalGatewayAcceptanceComplete !== false) {
    throw sanitizedError("refused");
  }
  return Object.freeze({ schema: "control-room.owner-bootstrap-complete/v1", ownerCreated: true,
    normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false });
}

function existingOwnerEvidence(value: unknown, context: PrivateFirstOwnerRunnerContextV1,
  ceremonyOutcomeDigest: string): PrivateFirstOwnerExistingOwnerEvidenceV1 {
  const result = exactRecord(value, ["schema", "installationId", "requestDigest", "installationPlanDigest",
    "installationPlanRevision", "releaseDigest", "databaseAuthorityOutcomeDigest", "expectedOwnerSubjectDigest",
    "ownerConfirmed", "ownerState", "ownerProofDigest", "ceremonyOutcomeDigest", "outcome"]);
  const binding = context.binding, ownerProofDigest = digest(result.ownerProofDigest);
  if (result.schema !== PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1 || result.installationId !== binding.installationId
    || result.requestDigest !== context.requestDigest || result.installationPlanDigest !== binding.installationPlanDigest
    || result.installationPlanRevision !== binding.installationPlanRevision || result.releaseDigest !== binding.releaseDigest
    || result.databaseAuthorityOutcomeDigest !== binding.databaseAuthorityOutcomeDigest
    || result.expectedOwnerSubjectDigest !== binding.expectedOwnerSubjectDigest || result.ownerConfirmed !== true
    || result.ownerState !== "existing" || ownerProofDigest === context.request.initialOwnerProofDigest
    || result.ceremonyOutcomeDigest !== ceremonyOutcomeDigest || result.outcome !== "verified") throw sanitizedError("refused");
  return Object.freeze({ schema: PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1,
    installationId: binding.installationId, requestDigest: context.requestDigest,
    installationPlanDigest: binding.installationPlanDigest, installationPlanRevision: binding.installationPlanRevision,
    releaseDigest: binding.releaseDigest, databaseAuthorityOutcomeDigest: binding.databaseAuthorityOutcomeDigest,
    expectedOwnerSubjectDigest: binding.expectedOwnerSubjectDigest, ownerConfirmed: true, ownerState: "existing",
    ownerProofDigest, ceremonyOutcomeDigest, outcome: "verified" });
}

async function invoke<T>(call: () => Promise<T>, operationSignal: AbortSignal, absoluteDeadline: number,
  timeoutKind: FailureKind): Promise<T> {
  if (operationSignal.aborted || Date.now() >= absoluteDeadline) throw sanitizedError(timeoutKind);
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      operationSignal.removeEventListener("abort", cancel);
    };
    const cancel = () => { done(); reject(sanitizedError(timeoutKind)); };
    timer = setTimeout(cancel, Math.max(0, absoluteDeadline - Date.now()));
    operationSignal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(call).then(result => { done(); resolve(result); }, error => { done(); reject(error); });
  });
}

async function cleanup(runtime: PrivateFirstOwnerRuntimeV1, context: PrivateFirstOwnerRunnerContextV1): Promise<boolean> {
  const controller = new AbortController();
  const absoluteDeadline = Date.now() + runtime.cleanupDeadlineMs;
  try {
    const value = await invoke(() => runtime.cleanupRetainedOwnerBootstrapCeremony(Object.freeze({
      request: context.request, requestDigest: context.requestDigest, binding: context.binding, signal: controller.signal,
      scope: "retained_owner_bootstrap_ceremony" as const,
    })), controller.signal, absoluteDeadline, "uncertain");
    const result = exactRecord(value, ["schema", "installationId", "requestDigest", "scope", "outcome"]);
    return result.schema === PRIVATE_FIRST_OWNER_CLEANUP_V1 && result.installationId === context.binding.installationId
      && result.requestDigest === context.requestDigest && result.scope === "retained_owner_bootstrap_ceremony"
      && result.outcome === "confirmed";
  } catch { return false; }
  finally { controller.abort(); }
}

async function runInternal(actionInput: unknown, runtimeInput: unknown): Promise<PrivateFirstOwnerRunnerResultV1> {
  const request = prepareFirstOwnerActionTransactionRequestV1(actionInput), runtime = captureRuntime(runtimeInput);
  const preparedRequestDigest = requestDigest(request);
  const context = Object.freeze({ request, requestDigest: preparedRequestDigest, binding: runtime.binding,
    signal: runtime.signal });
  const absoluteDeadline = Date.now() + runtime.controlDeadlineMs;
  let effectStarted = false;
  let result: Omit<PrivateFirstOwnerRunnerResultV1, "cleanupConfirmed"> | undefined;
  let failure: FailureKind | undefined;
  try {
    if (runtime.signal.aborted) throw sanitizedError("refused");
    assertBinding(request, runtime.binding);
    assertAttached(await invoke(() => runtime.confirmOwnerAttachedTerminal(context), runtime.signal, absoluteDeadline, "refused"), context);
    if (runtime.signal.aborted || Date.now() >= absoluteDeadline) throw sanitizedError("refused");
    effectStarted = true;
    const completed = completion(await invoke(() => runtime.runRetainedOwnerBootstrapCeremony(context), runtime.signal,
      absoluteDeadline, "uncertain"));
    const ceremonyOutcomeDigest = sha256Digest({ purpose: "private-first-owner-ceremony-outcome/v1",
      installationId: runtime.binding.installationId, requestDigest: preparedRequestDigest, completion: completed });
    const evidenceContext = Object.freeze({ ...context, ceremonyOutcomeDigest });
    const evidence = existingOwnerEvidence(await invoke(() => runtime.verifyExistingOwner(evidenceContext), runtime.signal,
      absoluteDeadline, "uncertain"), context, ceremonyOutcomeDigest);
    if (runtime.signal.aborted || Date.now() >= absoluteDeadline) throw sanitizedError("uncertain");
    const terminalConfirmation: FirstOwnerActionTerminalConfirmationV1 = Object.freeze({
      schema: FIRST_OWNER_ACTION_TERMINAL_CONFIRMATION_V1, installationId: runtime.binding.installationId,
      requestDigest: preparedRequestDigest,
      expectedOwnerSubjectDigest: request.expectedOwnerSubjectDigest, ownerConfirmed: true, ownerState: "existing",
      ownerProofDigest: evidence.ownerProofDigest, ceremonyOutcomeDigest, terminalState: "confirmed" });
    result = Object.freeze({ schema: PRIVATE_FIRST_OWNER_RUNNER_V1, installationId: runtime.binding.installationId,
      requestDigest: preparedRequestDigest, installationPlanDigest: request.installationPlanDigest,
      installationPlanRevision: request.installationPlanRevision, releaseDigest: request.releaseDigest,
      databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest,
      expectedOwnerSubjectDigest: request.expectedOwnerSubjectDigest, ownerState: "existing", ownerProofDigest: evidence.ownerProofDigest,
      ceremonyOutcomeDigest, disposition: "terminal_confirmation", terminalConfirmation });
  } catch (error) {
    failure = effectStarted || failureKind(error) === "uncertain" ? "uncertain" : "refused";
  }
  const cleanupConfirmed = await cleanup(runtime, context);
  if (!cleanupConfirmed) failure = effectStarted ? "uncertain" : "refused";
  if (runtime.signal.aborted && effectStarted) failure = "uncertain";
  if (failure || !result) throw sanitizedError(failure ?? (effectStarted ? "uncertain" : "refused"));
  return Object.freeze({ ...result, cleanupConfirmed: true });
}

export async function runPrivateFirstOwnerActionV1(actionInput: unknown,
  runtimeInput: unknown): Promise<PrivateFirstOwnerRunnerResultV1> {
  try { return await runInternal(actionInput, runtimeInput); }
  catch (error) { throw sanitizedError(failureKind(error) ?? "refused"); }
}
