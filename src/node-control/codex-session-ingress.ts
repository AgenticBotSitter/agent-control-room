import { nativeTaskSubmissionReferenceSchema, type NativeTaskSubmissionReference } from "../persistence/native-task-submission";
import { captureCodexCurrentAdmissionResponderV1, type createCodexCurrentAdmissionReadResponderV1 } from "../web/v1/codex-current-admission-read";
import { captureOwnedCodexResultIntakeV1, type CodexResultIntakeV1 } from "../web/v1/codex-result-intake";

declare const ingressBrand: unique symbol;
export type CodexSessionIngressV1 = Readonly<{ readonly [ingressBrand]: true }>;
type Captured = Readonly<{
  responder: ReturnType<typeof captureCodexCurrentAdmissionResponderV1>;
  result: ReturnType<typeof captureOwnedCodexResultIntakeV1>;
  reference: Readonly<NativeTaskSubmissionReference>;
}>;
const mounts = new WeakMap<object, Captured>();

/** Non-executing, one-use construction input. No raw-frame callbacks or transport escape. */
export function createCodexSessionIngressV1(input: {
  responder: ReturnType<typeof createCodexCurrentAdmissionReadResponderV1>;
  result: CodexResultIntakeV1;
  reference: NativeTaskSubmissionReference;
}): CodexSessionIngressV1 {
  const captured = Object.freeze({ responder: captureCodexCurrentAdmissionResponderV1(input.responder),
    result: captureOwnedCodexResultIntakeV1(input.result),
    reference: Object.freeze(nativeTaskSubmissionReferenceSchema.parse(input.reference)) });
  const capability = Object.freeze({}) as CodexSessionIngressV1;
  mounts.set(capability, captured);
  return capability;
}

export function consumeCodexSessionIngressV1(value: CodexSessionIngressV1): Captured {
  const captured = mounts.get(value);
  if (!captured) throw new Error("Codex session ingress unavailable");
  mounts.delete(value);
  return captured;
}
